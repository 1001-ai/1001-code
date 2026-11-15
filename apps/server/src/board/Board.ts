import {
  BoardError,
  BoardViewer,
  CommandId,
  MessageId,
  type BoardCommentInput,
  type BoardCommentResult,
  type BoardConnection,
  type BoardData,
  type BoardIssueDetail,
  type BoardIssueDetailInput,
  type BoardSignIn,
  type BoardSnapshot,
  type ProjectId,
  type TeamCatalogLinear,
  type ThreadId,
  teamCatalogRepositoryMatches,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { HttpClient, HttpClientRequest } from "effect/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as TeamCatalog from "../teamCatalog/TeamCatalog.ts";
import { linkedThreadIds } from "./linearInboxRouting.ts";
import {
  COMMENT_CREATE_MUTATION,
  CommentCreateData,
  ISSUE_DETAIL_QUERY,
  ISSUE_PAGE_SIZE,
  ISSUES_QUERY,
  IssueDetailData,
  IssuesData,
  LINEAR_API_URL,
  type LinearIssue,
  MAX_ISSUE_PAGES,
  TEAM_QUERY,
  TeamData,
  VIEWER_QUERY,
  ViewerData,
  boardColumns,
  boardIssueDetail,
  commentAuthor,
  issuesFilter,
  linearFailure,
  linearProject,
  postedCommentText,
} from "./linearBoard.ts";
import {
  LINEAR_OAUTH_ENDPOINTS,
  TokenResponse,
  authorizeUrl,
  redirectUriFor,
  standInEndpoints,
  tokenFailure,
} from "./linearOAuth.ts";

/**
 * A team project's Linear board, read as the person who signed in to Linear on this environment.
 * The OAuth tokens live in the server secret store and never reach clients. Reads happen when a
 * client opens or refreshes a board and every 30 seconds while one is open. `LinearInbox` reads
 * new comments through `session` while someone is signed in.
 */
export class Board extends Context.Service<
  Board,
  {
    readonly connection: Effect.Effect<BoardConnection>;
    /** The current connection, then every change. */
    readonly connectionChanges: Stream.Stream<BoardConnection>;
    /** Starts a sign-in that Linear sends back to `callbackOrigin`; the browser goes to the URL. */
    readonly startSignIn: (callbackOrigin: string) => Effect.Effect<BoardSignIn, BoardError>;
    /** Finishes a sign-in from Linear's redirect, storing the tokens only when it all checks out. */
    readonly completeSignIn: (params: {
      readonly state: string | null;
      readonly code: string | null;
      readonly error: string | null;
    }) => Effect.Effect<BoardViewer, BoardSignInError>;
    /** Forgets the sign-in here and revokes it at Linear. */
    readonly disconnect: Effect.Effect<BoardConnection>;
    /** The project's board, from a read in the last few seconds unless `refresh` is set. */
    readonly read: (
      projectId: ProjectId,
      options?: { readonly refresh?: boolean },
    ) => Effect.Effect<BoardSnapshot>;
    /** The board now, then again when it is refreshed, changes in Linear, or the sign-in changes. */
    readonly changes: (projectId: ProjectId) => Stream.Stream<BoardSnapshot>;
    readonly refresh: (projectId: ProjectId) => Effect.Effect<BoardSnapshot>;
    /** What a card leaves out of an issue on the project's board, read from Linear now. */
    readonly issueDetail: (
      input: BoardIssueDetailInput,
    ) => Effect.Effect<BoardIssueDetail, BoardError>;
    /**
     * Posts a comment on an issue on the project's board as the signed-in person, then queues it
     * in the issue's linked thread, if any, as the user's message.
     */
    readonly comment: (input: BoardCommentInput) => Effect.Effect<BoardCommentResult, BoardError>;
    /** Linear as whoever is signed in now, or null while nobody is. */
    readonly session: Effect.Effect<BoardLinearSession | null>;
  }
>()("t3/board/Board") {}

/** Queries as one sign-in; they fail as unauthorized once it is replaced or disconnected. */
export interface BoardLinearSession {
  readonly viewerId: string;
  readonly query: <S extends Schema.Top & { readonly DecodingServices: never }>(
    query: string,
    variables: Record<string, unknown>,
    schema: S,
  ) => Effect.Effect<S["Type"], BoardError>;
}

/** Why a sign-in could not finish, for the page Linear redirected the browser to. */
export class BoardSignInError extends Schema.TaggedError<BoardSignInError>()("BoardSignInError", {
  message: Schema.String,
}) {}

export const CREDENTIAL_SECRET_NAME = "board-linear-credential";
/** The Linear OAuth application's client id; sign-in is unavailable without it. */
export const CLIENT_ID_ENV = "T3CODE_LINEAR_CLIENT_ID";
/** Dev-only: point the board at a local Linear stand-in. Ignored outside `vp run dev`. */
const DEV_LINEAR_API_URL_ENV = "T3CODE_DEV_LINEAR_API_URL";

const FRESH_FOR_MS = 30_000;
/** How often an open board is read again from Linear. */
const POLL_INTERVAL = Duration.seconds(30);
/** How long polling waits after a rate limit that names no retry time. */
const RATE_LIMIT_BACKOFF = Duration.minutes(5);
const REQUEST_TIMEOUT = "20 seconds";
/** Linear's access tokens last a day; refresh this long before one runs out. */
const REFRESH_EARLY_MS = 5 * 60_000;
const SIGN_IN_TTL_MS = 10 * 60_000;
const MAX_PENDING_SIGN_INS = 16;

const StoredCredential = Schema.fromJsonString(
  Schema.Struct({
    accessToken: Schema.String,
    refreshToken: Schema.String,
    /** Epoch milliseconds. */
    expiresAt: Schema.Number,
    viewer: BoardViewer,
  }),
);
type StoredCredential = typeof StoredCredential.Type;
const decodeCredential = Schema.decodeUnknownOption(StoredCredential);
const encodeCredential = Schema.encodeSync(StoredCredential);
const decodeTokenResponse = Schema.decodeUnknownEffect(TokenResponse);

type Target =
  | { readonly _tag: "linear"; readonly linear: TeamCatalogLinear }
  | { readonly _tag: "unconfigured"; readonly snapshot: BoardSnapshot };

const unconfigured = (
  reason: Extract<BoardSnapshot, { status: "unconfigured" }>["reason"],
  catalogFile: string | null = null,
): Target => ({ _tag: "unconfigured", snapshot: { status: "unconfigured", reason, catalogFile } });

/** A refreshed project's snapshot, or null when every board changed with the connection. */
type BoardSignal = { readonly projectId: ProjectId; readonly snapshot: BoardSnapshot } | null;

interface CachedBoard {
  readonly board: BoardData;
  readonly readAtMs: number;
}

interface PendingSignIn {
  readonly verifier: string;
  readonly redirectUri: string;
  readonly expiresAtMs: number;
}

type Tokens = Pick<StoredCredential, "accessToken" | "refreshToken" | "expiresAt">;
type TokenFailure = ReturnType<typeof tokenFailure>;

/** The snapshot without its read time, so a poll that finds no change publishes nothing. */
const pollFingerprint = (snapshot: BoardSnapshot) =>
  JSON.stringify(
    snapshot.status === "ready"
      ? { ...snapshot, board: { ...snapshot.board, fetchedAt: "" } }
      : snapshot,
  );

/** When polling may next reach Linear after `snapshot` was shown: later after a rate limit. */
const quietUntil = (snapshot: BoardSnapshot, nowMs: number) => {
  const failure = "failure" in snapshot ? snapshot.failure : null;
  if (failure?.reason !== "rate-limited") return 0;
  return (
    nowMs +
    (failure.retryAfterSeconds === undefined
      ? Duration.toMillis(RATE_LIMIT_BACKOFF)
      : failure.retryAfterSeconds * 1000)
  );
};

/** One project's poll, shared by every client that has its board open. */
interface Poll {
  subscribers: number;
  fiber: Fiber.Fiber<void> | null;
  /** The fingerprint of the snapshot open boards last got, from a poll or a refresh. */
  shown: string | null;
  /** No poll reaches Linear before this, after a rate limit any read saw. */
  quietUntilMs: number;
}

const make = Effect.gen(function* () {
  const layerScope = yield* Effect.scope;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const httpClient = yield* HttpClient.HttpClient;
  const config = yield* ServerConfig.ServerConfig;
  const environment = yield* HostProcess.Environment;
  const teamCatalog = yield* TeamCatalog.TeamCatalog;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const identities = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
  const random = yield* SecureRandom.SecureRandom;
  const digest = yield* Digest.Digest;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const environmentId = yield* (yield* ServerEnvironment.ServerEnvironment).getEnvironmentId;

  const clientId = environment[CLIENT_ID_ENV]?.trim() || null;
  const devEndpoint = environment[DEV_LINEAR_API_URL_ENV]?.trim();
  const standIn = config.devUrl !== undefined && devEndpoint ? devEndpoint : null;
  const endpoint = standIn ?? LINEAR_API_URL;
  const oauthEndpoints = standIn === null ? LINEAR_OAUTH_ENDPOINTS : standInEndpoints(standIn);

  const storedBytes = secrets.get(CREDENTIAL_SECRET_NAME).pipe(Effect.orDie);
  // A credential this version cannot read, such as an old API key, is removed, not left behind.
  const stored = yield* storedBytes;
  if (
    Option.isSome(stored) &&
    Option.isNone(decodeCredential(new TextDecoder().decode(stored.value)))
  ) {
    yield* secrets.remove(CREDENTIAL_SECRET_NAME).pipe(Effect.orDie);
  }

  /** The stored sign-in, kept but unused while the environment has no client id. */
  const readCredential = storedBytes.pipe(
    Effect.map((bytes) =>
      clientId === null
        ? null
        : Option.getOrNull(
            Option.flatMap(bytes, (value) => decodeCredential(new TextDecoder().decode(value))),
          ),
    ),
  );

  const toConnection = (credential: StoredCredential | null): BoardConnection =>
    clientId === null
      ? { status: "unavailable" }
      : credential === null
        ? { status: "disconnected" }
        : { status: "connected", viewer: credential.viewer };

  const connectionState = yield* SubscriptionRef.make(toConnection(yield* readCredential));
  const boardSignals = yield* PubSub.unbounded<BoardSignal>();
  const cache = new Map<string, CachedBoard>();
  const readLock = yield* Semaphore.make(1);
  // Bumped on every sign-in change; a refresh publishes only if no change happened while it read.
  let credentialGeneration = 0;
  // Every read or write of the stored sign-in, including a refresh, happens under this lock.
  const credentialLock = yield* Semaphore.make(1);
  const pendingSignIns = new Map<string, PendingSignIn>();
  /** The state of the newest sign-in; only its failure is shown, not an older attempt's. */
  let latestSignIn: string | null = null;

  const linearRequest = Effect.fn("Board.linearRequest")(function* <S extends Schema.Top>(
    accessToken: string,
    query: string,
    variables: Record<string, unknown>,
    schema: S,
  ) {
    const response = yield* httpClient
      .execute(
        HttpClientRequest.post(endpoint).pipe(
          HttpClientRequest.setHeaders({
            authorization: `Bearer ${accessToken}`,
            accept: "application/json",
          }),
          HttpClientRequest.bodyJsonUnsafe({ query, variables }),
        ),
      )
      .pipe(
        Effect.timeout(REQUEST_TIMEOUT),
        Effect.mapError(
          () => new BoardError({ reason: "unreachable", detail: "Could not reach Linear." }),
        ),
      );
    const body: unknown = yield* response.json.pipe(Effect.orElseSucceed(() => null));
    const failure = linearFailure({
      status: response.status,
      body,
      retryAfter: response.headers["retry-after"],
    });
    if (failure !== null) return yield* failure;
    const data =
      body !== null && typeof body === "object" && "data" in body ? body.data : undefined;
    return yield* Schema.decodeUnknownEffect(schema)(data).pipe(
      Effect.mapError(
        () =>
          new BoardError({
            reason: "invalid-response",
            detail: "Linear answered in a shape the board does not understand.",
          }),
      ),
    );
  });

  const tokenRequest = Effect.fn("Board.tokenRequest")(function* (params: Record<string, string>) {
    const response = yield* httpClient
      .execute(
        HttpClientRequest.post(oauthEndpoints.token).pipe(
          HttpClientRequest.setHeaders({ accept: "application/json" }),
          HttpClientRequest.bodyUrlParams(params),
        ),
      )
      .pipe(
        Effect.timeout(REQUEST_TIMEOUT),
        Effect.mapError((): TokenFailure => ({
          dead: false,
          error: new BoardError({ reason: "unreachable", detail: "Could not reach Linear." }),
        })),
      );
    const body: unknown = yield* response.json.pipe(Effect.orElseSucceed(() => null));
    if (response.status !== 200) return yield* Effect.fail(tokenFailure(response.status, body));
    const tokens = yield* decodeTokenResponse(body).pipe(
      Effect.mapError((): TokenFailure => ({
        dead: false,
        error: new BoardError({
          reason: "invalid-response",
          detail: "Linear's sign-in service answered in an unexpected shape.",
        }),
      })),
    );
    const now = yield* Clock.currentTimeMillis;
    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: now + tokens.expires_in * 1000,
    } satisfies Tokens;
  });

  /**
   * An access token of the sign-in a read started with (`generation`): the stored one, or a
   * refreshed one when it is about to expire or is the token Linear just `rejected`.
   */
  const accessToken = (generation: number, rejected: string | null) =>
    credentialLock.withPermits(1)(
      Effect.gen(function* () {
        const credential = yield* readCredential;
        // A read never carries on, or mixes pages, across a sign-in change.
        if (credential === null || clientId === null || generation !== credentialGeneration) {
          return yield* new BoardError({
            reason: "unauthorized",
            detail: "The Linear sign-in changed while the board was read.",
          });
        }
        const now = yield* Clock.currentTimeMillis;
        if (credential.accessToken !== rejected && credential.expiresAt - REFRESH_EARLY_MS > now) {
          return credential.accessToken;
        }
        // Linear rotates the refresh token as it answers, so its reply is stored before anything
        // can interrupt; the lock keeps one refresh at a time.
        return yield* Effect.uninterruptible(
          Effect.gen(function* () {
            const refreshed = yield* tokenRequest({
              grant_type: "refresh_token",
              refresh_token: credential.refreshToken,
              client_id: clientId,
            }).pipe(
              Effect.catch((failure) =>
                (failure.dead ? applyCredential(null) : Effect.void).pipe(
                  Effect.andThen(Effect.fail(failure.error)),
                ),
              ),
            );
            yield* writeCredential({ ...credential, ...refreshed });
            return refreshed.accessToken;
          }),
        );
      }),
    );

  /** A Linear query as the signed-in person, refreshing the token once if Linear rejects it. */
  const linear = Effect.fn("Board.linear")(function* <S extends Schema.Top>(
    generation: number,
    query: string,
    variables: Record<string, unknown>,
    schema: S,
  ) {
    const token = yield* accessToken(generation, null);
    return yield* linearRequest(token, query, variables, schema).pipe(
      Effect.catchIf(
        (error) => error.reason === "unauthorized",
        () =>
          accessToken(generation, token).pipe(
            Effect.flatMap((fresh) => linearRequest(fresh, query, variables, schema)),
          ),
      ),
    );
  });

  /** The catalog's Linear team and project, as this sign-in sees them. */
  const findTeam = Effect.fn("Board.findTeam")(function* (
    generation: number,
    target: TeamCatalogLinear,
  ) {
    const teamData = yield* linear(
      generation,
      TEAM_QUERY,
      {
        key: target.team,
        project: target.project ?? "",
        withProject: target.project !== undefined,
      },
      TeamData,
    );
    const team = teamData.teams.nodes[0];
    if (team === undefined) {
      return yield* new BoardError({
        reason: "team-not-found",
        detail: `No Linear team with the key ${target.team} is visible to your Linear account.`,
      });
    }
    const project =
      target.project === undefined
        ? null
        : linearProject(team.projects?.nodes ?? [], target.project);
    if (project === "ambiguous") {
      return yield* new BoardError({
        reason: "project-not-found",
        detail: `The Linear team ${team.key} has more than one project named ${target.project}. Name it by the id at the end of its URL.`,
      });
    }
    if (target.project !== undefined && project === null) {
      return yield* new BoardError({
        reason: "project-not-found",
        detail: `The Linear team ${team.key} has no project named ${target.project}.`,
      });
    }
    return { team, project };
  });

  const fetchBoard = Effect.fn("Board.fetchBoard")(function* (
    generation: number,
    target: TeamCatalogLinear,
  ) {
    const { team, project } = yield* findTeam(generation, target);
    const filter = issuesFilter(team.id, project?.id ?? null);
    const issues: LinearIssue[] = [];
    let after: string | null = null;
    let truncated = false;
    for (let page = 0; page < MAX_ISSUE_PAGES; page += 1) {
      const data: IssuesData = yield* linear(
        generation,
        ISSUES_QUERY,
        { filter, first: ISSUE_PAGE_SIZE, after },
        IssuesData,
      );
      issues.push(...data.issues.nodes);
      after = data.issues.pageInfo.endCursor;
      truncated = data.issues.pageInfo.hasNextPage;
      if (!truncated || after === null) break;
    }

    const now = yield* DateTime.now;
    const board: BoardData = {
      team: { id: team.id, key: team.key, name: team.name },
      project,
      columns: boardColumns(team.states.nodes, issues),
      truncated,
      fetchedAt: DateTime.formatIso(now),
    };
    return board;
  });

  const resolveTarget = Effect.fn("Board.resolveTarget")(function* (projectId: ProjectId) {
    const catalog = yield* teamCatalog.snapshot;
    if (catalog.source === null) return unconfigured("no-catalog");
    const project = yield* projects
      .get(projectId)
      .pipe(Effect.orElseSucceed(() => Option.none<ProjectStore.ProjectRow>()));
    const identity = Option.isSome(project)
      ? yield* identities.resolve(project.value.workspaceRoot)
      : null;
    const entry = catalog.projects.find((candidate) =>
      teamCatalogRepositoryMatches(candidate.project.repo, identity),
    );
    if (entry === undefined) return unconfigured("not-in-catalog");
    if (entry.project.linear === undefined) return unconfigured("no-linear-team", entry.file);
    return { _tag: "linear", linear: entry.project.linear } satisfies Target;
  });

  // Keyed by sign-in too, so a read still in flight when it changes cannot be served later.
  const cacheKey = (generation: number, linear: TeamCatalogLinear) =>
    `${generation}\u0000${linear.team}\u0000${linear.project ?? ""}`;

  const read: Board["Service"]["read"] = Effect.fn("Board.read")(function* (projectId, options) {
    const generation = credentialGeneration;
    const credential = yield* readCredential;
    if (credential === null) return { status: "not-connected" } satisfies BoardSnapshot;
    const target = yield* resolveTarget(projectId);
    if (target._tag === "unconfigured") return target.snapshot;

    const key = cacheKey(generation, target.linear);
    return yield* readLock.withPermits(1)(
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const cached = cache.get(key);
        if (options?.refresh !== true && cached && now - cached.readAtMs < FRESH_FOR_MS) {
          return { status: "ready", board: cached.board, failure: null } satisfies BoardSnapshot;
        }
        const outcome = yield* fetchBoard(generation, target.linear).pipe(
          Effect.map((board) => ({ board, error: null })),
          Effect.catch((error) => Effect.succeed({ board: null, error })),
        );
        if (outcome.board !== null) {
          cache.set(key, { board: outcome.board, readAtMs: now });
          return { status: "ready", board: outcome.board, failure: null } satisfies BoardSnapshot;
        }
        const { error } = outcome;
        const failure = {
          reason: error.reason,
          detail: error.detail,
          ...(error.retryAfterSeconds === undefined
            ? {}
            : { retryAfterSeconds: error.retryAfterSeconds }),
        };
        // A rejected key or a missing team makes the old board wrong, not just stale.
        if (cached && (failure.reason === "rate-limited" || failure.reason === "unreachable")) {
          return { status: "ready", board: cached.board, failure } satisfies BoardSnapshot;
        }
        cache.delete(key);
        return { status: "failed", failure } satisfies BoardSnapshot;
      }),
    );
  });

  /** An issue on the project's board, read from Linear now as the signed-in person. */
  const readIssue = Effect.fn("Board.readIssue")(function* (input: BoardIssueDetailInput) {
    const generation = credentialGeneration;
    const credential = yield* readCredential;
    if (credential === null) {
      return yield* new BoardError({
        reason: "unauthorized",
        detail: "Sign in to Linear in Settings → Board to read this issue.",
      });
    }
    const notOnBoard = new BoardError({
      reason: "issue-not-found",
      detail: "This issue is not on the project's board.",
    });
    const target = yield* resolveTarget(input.projectId);
    if (target._tag === "unconfigured") return yield* notOnBoard;
    const cached = cache.get(cacheKey(generation, target.linear))?.board;
    const scope = cached ?? (yield* findTeam(generation, target.linear));
    const { issue } = yield* linear(
      generation,
      ISSUE_DETAIL_QUERY,
      { id: input.issueId },
      IssueDetailData,
    );
    if (
      issue === null ||
      issue.team.id !== scope.team.id ||
      (scope.project !== null && issue.project?.id !== scope.project.id)
    ) {
      return yield* notOnBoard;
    }
    const threadIds = linkedThreadIds(issue.threadLinks.nodes, credential.viewer.id, environmentId);
    return { generation, issue, threadIds };
  });

  /** The first of a link's id candidates that names a thread here, or null. */
  const findLinkedThread = Effect.fn("Board.findLinkedThread")(function* (
    threadIds: ReadonlyArray<ThreadId>,
  ) {
    for (const threadId of threadIds) {
      const thread = yield* threads.getThreadShell(threadId);
      if (thread !== null) return { threadId, thread };
    }
    return null;
  });

  const issueDetail: Board["Service"]["issueDetail"] = Effect.fn("Board.issueDetail")(
    function* (input) {
      const { issue, threadIds } = yield* readIssue(input);
      // A failed lookup only hides the link; the issue still reads.
      const linked = yield* findLinkedThread(threadIds).pipe(Effect.orElseSucceed(() => null));
      return boardIssueDetail(issue, linked?.threadId ?? null);
    },
  );

  /** Queues the user's comment in the linked thread; Linear has it already, so failing here only logs. */
  const queueComment = Effect.fn("Board.queueComment")(function* (
    threadIds: ReadonlyArray<ThreadId>,
    commentId: string,
    text: string,
  ) {
    const linked = yield* findLinkedThread(threadIds);
    if (linked === null) return null;
    const { threadId, thread } = linked;
    const key = `board-comment:${threadId}:${commentId}`;
    yield* threads.sendToThread({
      projectId: thread.projectId,
      commandId: CommandId.make(key),
      threadId,
      messageId: MessageId.make(key),
      text,
      attachments: [],
      mode: "queue",
      createdBy: "user",
      creationSource: "web",
    });
    return threadId;
  });

  const comment: Board["Service"]["comment"] = Effect.fn("Board.comment")(function* (input) {
    const { generation, issue, threadIds } = yield* readIssue(input);
    const { commentCreate } = yield* linear(
      generation,
      COMMENT_CREATE_MUTATION,
      {
        input: {
          issueId: issue.id,
          body: input.body,
          ...(input.parentId === undefined ? {} : { parentId: input.parentId }),
        },
      },
      CommentCreateData,
    );
    if (!commentCreate.success) {
      return yield* new BoardError({
        reason: "invalid-response",
        detail: "Linear did not accept the comment.",
      });
    }
    if (threadIds.length === 0) return { threadId: null };
    const parent =
      input.parentId === undefined
        ? undefined
        : issue.comments.nodes.find((candidate) => candidate.id === input.parentId);
    const text = postedCommentText({
      issue: issue.identifier,
      body: input.body,
      replyTo:
        input.parentId === undefined
          ? null
          : parent === undefined
            ? "someone"
            : commentAuthor(parent),
    });
    // Linear has the comment, so a failed lookup or send only logs; the panel says it did not reach the thread.
    const queued = yield* queueComment(threadIds, commentCreate.comment.id, text).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Board could not send a comment to its thread.", {
          comment: commentCreate.comment.id,
          threadIds,
          error,
        }).pipe(Effect.as(null)),
      ),
    );
    return { threadId: queued };
  });

  // One poll per project however many clients have its board open; the last to leave stops it.
  const polls = new Map<ProjectId, Poll>();
  const pollsLock = yield* Semaphore.make(1);

  /**
   * Sends a snapshot to the project's open boards unless the sign-in changed since its read, or,
   * for a poll's snapshot (`from`), unless that poll was stopped since.
   */
  const publish = (
    projectId: ProjectId,
    snapshot: BoardSnapshot,
    generation: number,
    from?: Poll,
  ) =>
    credentialLock.withPermits(1)(
      Effect.suspend(() => {
        const open = polls.get(projectId);
        if (generation !== credentialGeneration || (from !== undefined && from !== open)) {
          return Effect.succeed(false);
        }
        return Effect.flatMap(Clock.currentTimeMillis, (now) => {
          if (open !== undefined) {
            open.shown = pollFingerprint(snapshot);
            open.quietUntilMs = quietUntil(snapshot, now);
          }
          return PubSub.publish(boardSignals, { projectId, snapshot });
        });
      }),
    );

  const refresh: Board["Service"]["refresh"] = Effect.fn("Board.refresh")(function* (projectId) {
    // A catalog edit, such as a new `linear` field, should count on the next refresh.
    yield* teamCatalog.refresh({ force: true });
    const generation = credentialGeneration;
    const snapshot = yield* read(projectId, { refresh: true });
    // Open boards get this snapshot itself: a re-read would hit the cache and drop its failure.
    const published = yield* publish(projectId, snapshot, generation);
    return published ? snapshot : yield* read(projectId);
  });

  /**
   * Reads an open board from Linear again every 30 seconds and publishes it when it differs from
   * what open boards last got. The first step only records the board the subscriber was just
   * served, normally from the cache; later ones skip it, so a poll never republishes a cached read
   * over a newer warning. Unlike `refresh`, a poll does not fetch the team catalog.
   */
  const poll = (projectId: ProjectId, state: Poll) => {
    const step = Effect.fn("Board.poll")(function* () {
      if ((yield* Clock.currentTimeMillis) < state.quietUntilMs) return;
      const generation = credentialGeneration;
      const snapshot = yield* read(projectId, { refresh: state.shown !== null });
      const fingerprint = pollFingerprint(snapshot);
      if (state.shown !== null && fingerprint !== state.shown) {
        yield* publish(projectId, snapshot, generation, state);
        return;
      }
      state.shown = fingerprint;
      state.quietUntilMs = quietUntil(snapshot, yield* Clock.currentTimeMillis);
    });
    return step().pipe(
      Effect.repeat(
        Schedule.spaced(POLL_INTERVAL).pipe(
          Schedule.modifyDelay(({ duration }) =>
            Effect.map(Clock.currentTimeMillis, (now) =>
              Duration.max(duration, Duration.millis(Math.max(0, state.quietUntilMs - now))),
            ),
          ),
        ),
      ),
      Effect.asVoid,
    );
  };

  const openPoll = (projectId: ProjectId) =>
    pollsLock.withPermits(1)(
      Effect.gen(function* () {
        const open = polls.get(projectId);
        if (open !== undefined) {
          open.subscribers += 1;
          return;
        }
        const state: Poll = { subscribers: 1, fiber: null, shown: null, quietUntilMs: 0 };
        polls.set(projectId, state);
        state.fiber = yield* poll(projectId, state).pipe(Effect.forkIn(layerScope));
      }),
    );

  const closePoll = (projectId: ProjectId) =>
    pollsLock
      .withPermits(1)(
        Effect.sync(() => {
          const open = polls.get(projectId);
          if (open === undefined || --open.subscribers > 0) return null;
          polls.delete(projectId);
          return open.fiber;
        }),
      )
      .pipe(Effect.flatMap((fiber) => (fiber === null ? Effect.void : Fiber.interrupt(fiber))));

  const changes: Board["Service"]["changes"] = (projectId) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(boardSignals);
        yield* Effect.acquireRelease(openPoll(projectId), () => closePoll(projectId));
        return Stream.concat(
          Stream.fromEffect(read(projectId)),
          Stream.fromSubscription(subscription).pipe(
            Stream.filter((signal) => signal === null || signal.projectId === projectId),
            Stream.mapEffect((signal) =>
              signal === null ? read(projectId) : Effect.succeed(signal.snapshot),
            ),
          ),
        );
      }),
    );

  const writeCredential = (credential: StoredCredential) =>
    secrets
      .set(CREDENTIAL_SECRET_NAME, new TextEncoder().encode(encodeCredential(credential)))
      .pipe(Effect.orDie);

  /** Replaces the sign-in; the caller holds `credentialLock`. */
  const applyCredential = Effect.fn("Board.applyCredential")(function* (
    credential: StoredCredential | null,
  ) {
    if (credential === null) {
      yield* secrets.remove(CREDENTIAL_SECRET_NAME).pipe(Effect.orDie);
    } else {
      yield* writeCredential(credential);
    }
    cache.clear();
    credentialGeneration += 1;
    const connection = toConnection(credential);
    yield* SubscriptionRef.set(connectionState, connection);
    yield* PubSub.publish(boardSignals, null);
    return connection;
  });

  const startSignIn: Board["Service"]["startSignIn"] = Effect.fn("Board.startSignIn")(
    function* (callbackOrigin) {
      if (clientId === null) {
        return yield* new BoardError({
          reason: "sign-in-unavailable",
          detail: "Linear sign-in is not set up for this environment.",
        });
      }
      const redirectUri = redirectUriFor(callbackOrigin);
      if (redirectUri === null) {
        return yield* new BoardError({
          reason: "sign-in-unavailable",
          detail: "Linear cannot send a sign-in back to this environment's address.",
        });
      }
      const verifier = Base64Url.encode(yield* random.randomBytes(32));
      const challenge = Base64Url.encode(
        yield* digest.digest(Digest.sha256, new TextEncoder().encode(verifier)),
      );
      const state = Base64Url.encode(yield* random.randomBytes(32));
      const now = yield* Clock.currentTimeMillis;
      for (const [key, pending] of pendingSignIns) {
        if (pending.expiresAtMs <= now) pendingSignIns.delete(key);
      }
      // Oldest first, so a burst of abandoned sign-ins cannot grow this without bound.
      for (const key of pendingSignIns.keys()) {
        if (pendingSignIns.size < MAX_PENDING_SIGN_INS) break;
        pendingSignIns.delete(key);
      }
      pendingSignIns.set(state, { verifier, redirectUri, expiresAtMs: now + SIGN_IN_TTL_MS });
      latestSignIn = state;
      yield* setSignInFailure(null);
      return {
        authorizeUrl: authorizeUrl({
          endpoint: oauthEndpoints.authorize,
          clientId,
          redirectUri,
          state,
          codeChallenge: challenge,
        }),
      };
    },
  );

  const revoke = (token: string, hint: "access_token" | "refresh_token") =>
    httpClient
      .execute(
        HttpClientRequest.post(oauthEndpoints.revoke).pipe(
          HttpClientRequest.bodyUrlParams({ token, token_type_hint: hint }),
        ),
      )
      .pipe(Effect.timeout(REQUEST_TIMEOUT), Effect.ignore);

  const revokeTokens = (tokens: Tokens) =>
    revoke(tokens.refreshToken, "refresh_token").pipe(
      Effect.andThen(revoke(tokens.accessToken, "access_token")),
    );

  /** Settings shows why the last sign-in failed until the next one starts. */
  const setSignInFailure = (signInFailure: string | null) =>
    SubscriptionRef.update(connectionState, (connection): BoardConnection =>
      connection.status !== "disconnected"
        ? connection
        : signInFailure === null
          ? { status: "disconnected" }
          : { status: "disconnected", signInFailure },
    );

  const finishSignIn = Effect.fn("Board.finishSignIn")(function* (
    clientId: string,
    pending: PendingSignIn,
    params: Parameters<Board["Service"]["completeSignIn"]>[0],
    generation: number,
  ) {
    if (params.error !== null) {
      return yield* new BoardSignInError({
        message:
          params.error === "access_denied"
            ? "Linear sign-in was cancelled."
            : `Linear did not complete the sign-in (${params.error.slice(0, 100)}).`,
      });
    }
    if (params.code === null) {
      return yield* new BoardSignInError({ message: "Linear sent no authorization code." });
    }
    const tokens = yield* tokenRequest({
      grant_type: "authorization_code",
      code: params.code,
      redirect_uri: pending.redirectUri,
      client_id: clientId,
      code_verifier: pending.verifier,
    }).pipe(
      Effect.mapError(
        (failure) =>
          new BoardSignInError({
            message: failure.dead
              ? "Linear did not accept this sign-in. Start again from Settings → Board."
              : failure.error.detail,
          }),
      ),
    );
    // From here Linear has granted access; a sign-in that cannot be kept is revoked.
    const discard = (message: string) =>
      revokeTokens(tokens).pipe(Effect.andThen(Effect.fail(new BoardSignInError({ message }))));
    const data = yield* linearRequest(tokens.accessToken, VIEWER_QUERY, {}, ViewerData).pipe(
      Effect.catch((error) => discard(error.detail)),
    );
    const viewer: BoardViewer = {
      id: data.viewer.id,
      name: data.viewer.name,
      email: data.viewer.email,
      workspace: data.organization.name,
    };
    const stored = yield* credentialLock.withPermits(1)(
      Effect.suspend(() =>
        generation === credentialGeneration
          ? applyCredential({ ...tokens, viewer }).pipe(Effect.as(true))
          : Effect.succeed(false),
      ),
    );
    if (!stored) {
      return yield* discard(
        "Linear was disconnected or signed in again while this sign-in finished. Start again from Settings → Board.",
      );
    }
    return viewer;
  });

  const completeSignIn: Board["Service"]["completeSignIn"] = Effect.fn("Board.completeSignIn")(
    function* (params) {
      const now = yield* Clock.currentTimeMillis;
      const pending = params.state === null ? undefined : pendingSignIns.get(params.state);
      if (params.state !== null) pendingSignIns.delete(params.state);
      if (clientId === null || pending === undefined || pending.expiresAtMs <= now) {
        return yield* new BoardSignInError({
          message:
            "This sign-in link has expired or was already used. Start again from Settings → Board.",
        });
      }
      // A disconnect or another sign-in from now on supersedes this one.
      const generation = credentialGeneration;
      // Uninterruptible: a browser closing its tab must not strand tokens Linear already issued.
      return yield* finishSignIn(clientId, pending, params, generation).pipe(
        Effect.tapError((error) =>
          params.state === latestSignIn ? setSignInFailure(error.message) : Effect.void,
        ),
        Effect.uninterruptible,
      );
    },
  );

  const disconnect = Effect.gen(function* () {
    const { connection, credential } = yield* credentialLock.withPermits(1)(
      Effect.gen(function* () {
        // A Linear tab still open from an earlier sign-in cannot sign back in.
        pendingSignIns.clear();
        latestSignIn = null;
        const credential = Option.getOrNull(
          Option.flatMap(yield* storedBytes, (value) =>
            decodeCredential(new TextDecoder().decode(value)),
          ),
        );
        return { connection: yield* applyCredential(null), credential };
      }),
    );
    // Forgotten here first, so a slow or unreachable Linear cannot keep the sign-in alive.
    if (credential !== null) yield* revokeTokens(credential);
    return connection;
  }).pipe(Effect.withSpan("Board.disconnect"));

  return Board.of({
    connection: SubscriptionRef.get(connectionState),
    connectionChanges: SubscriptionRef.changes(connectionState),
    startSignIn,
    completeSignIn,
    disconnect,
    read,
    changes,
    refresh,
    issueDetail,
    comment,
    session: Effect.gen(function* () {
      // Taken before the read, so a sign-in change in between fails the session's queries.
      const generation = credentialGeneration;
      const credential = yield* readCredential;
      if (credential === null) return null;
      return {
        viewerId: credential.viewer.id,
        // Untraced: `Board.linear` already spans the request.
        query: Effect.fnUntraced(function* <
          S extends Schema.Top & { readonly DecodingServices: never },
        >(query: string, variables: Record<string, unknown>, schema: S) {
          return yield* linear(generation, query, variables, schema);
        }),
      } satisfies BoardLinearSession;
    }),
  });
});

export const layer = Layer.effect(Board, make);
