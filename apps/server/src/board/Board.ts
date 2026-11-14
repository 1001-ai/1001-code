import {
  BoardError,
  BoardViewer,
  type BoardConnection,
  type BoardData,
  type BoardSnapshot,
  type ProjectId,
  type TeamCatalogLinear,
  teamCatalogRepositoryMatches,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { HttpClient, HttpClientRequest } from "effect/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as TeamCatalog from "../teamCatalog/TeamCatalog.ts";
import {
  ISSUE_PAGE_SIZE,
  ISSUES_QUERY,
  IssuesData,
  LINEAR_API_URL,
  type LinearIssue,
  MAX_ISSUE_PAGES,
  TEAM_QUERY,
  TeamData,
  VIEWER_QUERY,
  ViewerData,
  boardColumns,
  issuesFilter,
  linearFailure,
} from "./linearBoard.ts";

/**
 * A team project's Linear board, read with this environment owner's Linear API key. The key is
 * stored in the server secret store and never sent to clients. Reads happen when a client opens
 * or refreshes a board; nothing polls Linear while no board is open.
 */
export class Board extends Context.Service<
  Board,
  {
    readonly connection: Effect.Effect<BoardConnection>;
    /** The current connection, then every change. */
    readonly connectionChanges: Stream.Stream<BoardConnection>;
    /** Checks the key with Linear and stores it only when Linear accepts it. */
    readonly connect: (apiKey: string) => Effect.Effect<BoardConnection, BoardError>;
    readonly disconnect: Effect.Effect<BoardConnection>;
    /** The project's board, from a read in the last few seconds unless `refresh` is set. */
    readonly read: (
      projectId: ProjectId,
      options?: { readonly refresh?: boolean },
    ) => Effect.Effect<BoardSnapshot>;
    /** The board now, then again whenever it is refreshed or the connection changes. */
    readonly changes: (projectId: ProjectId) => Stream.Stream<BoardSnapshot>;
    readonly refresh: (projectId: ProjectId) => Effect.Effect<BoardSnapshot>;
  }
>()("t3/board/Board") {}

export const CREDENTIAL_SECRET_NAME = "board-linear-credential";
/** Dev-only: point the board at a local Linear stand-in. Ignored outside `vp run dev`. */
const DEV_LINEAR_API_URL_ENV = "T3CODE_DEV_LINEAR_API_URL";

const FRESH_FOR_MS = 30_000;
const REQUEST_TIMEOUT = "20 seconds";

const StoredCredential = Schema.fromJsonString(
  Schema.Struct({ apiKey: Schema.String, viewer: BoardViewer }),
);
type StoredCredential = typeof StoredCredential.Type;
const decodeCredential = Schema.decodeUnknownOption(StoredCredential);
const encodeCredential = Schema.encodeSync(StoredCredential);

type Target =
  | { readonly _tag: "linear"; readonly linear: TeamCatalogLinear }
  | { readonly _tag: "unconfigured"; readonly snapshot: BoardSnapshot };

const unconfigured = (
  reason: Extract<BoardSnapshot, { status: "unconfigured" }>["reason"],
  catalogFile: string | null = null,
): Target => ({ _tag: "unconfigured", snapshot: { status: "unconfigured", reason, catalogFile } });

interface CachedBoard {
  readonly board: BoardData;
  readonly readAtMs: number;
}

const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const httpClient = yield* HttpClient.HttpClient;
  const config = yield* ServerConfig.ServerConfig;
  const environment = yield* HostProcess.Environment;
  const teamCatalog = yield* TeamCatalog.TeamCatalog;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const identities = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;

  const devEndpoint = environment[DEV_LINEAR_API_URL_ENV]?.trim();
  const endpoint = config.devUrl !== undefined && devEndpoint ? devEndpoint : LINEAR_API_URL;

  const readCredential = secrets.get(CREDENTIAL_SECRET_NAME).pipe(
    Effect.map((bytes) =>
      Option.getOrNull(
        Option.flatMap(bytes, (value) => decodeCredential(new TextDecoder().decode(value))),
      ),
    ),
    Effect.orDie,
  );

  const toConnection = (credential: StoredCredential | null): BoardConnection =>
    credential === null
      ? { status: "disconnected" }
      : { status: "connected", viewer: credential.viewer };

  const connectionState = yield* SubscriptionRef.make(toConnection(yield* readCredential));
  /** A refreshed project's id, or null when every board changed with the connection. */
  const boardSignals = yield* PubSub.unbounded<ProjectId | null>();
  const cache = new Map<string, CachedBoard>();
  const readLock = yield* Semaphore.make(1);

  const linear = Effect.fn("Board.linear")(function* <S extends Schema.Top>(
    apiKey: string,
    query: string,
    variables: Record<string, unknown>,
    schema: S,
  ) {
    const response = yield* httpClient
      .execute(
        HttpClientRequest.post(endpoint).pipe(
          HttpClientRequest.setHeaders({ authorization: apiKey, accept: "application/json" }),
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

  const fetchBoard = Effect.fn("Board.fetchBoard")(function* (
    apiKey: string,
    target: TeamCatalogLinear,
  ) {
    const teamData = yield* linear(
      apiKey,
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
        detail: `No Linear team with the key ${target.team} is visible to this API key.`,
      });
    }
    const project = target.project === undefined ? null : (team.projects?.nodes[0] ?? null);
    if (target.project !== undefined && project === null) {
      return yield* new BoardError({
        reason: "project-not-found",
        detail: `The Linear team ${team.key} has no project named ${target.project}.`,
      });
    }

    const filter = issuesFilter(team.id, project?.id ?? null);
    const issues: LinearIssue[] = [];
    let after: string | null = null;
    let truncated = false;
    for (let page = 0; page < MAX_ISSUE_PAGES; page += 1) {
      const data: IssuesData = yield* linear(
        apiKey,
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

  const read: Board["Service"]["read"] = Effect.fn("Board.read")(function* (projectId, options) {
    const credential = yield* readCredential;
    if (credential === null) return { status: "not-connected" } satisfies BoardSnapshot;
    const target = yield* resolveTarget(projectId);
    if (target._tag === "unconfigured") return target.snapshot;

    const key = `${target.linear.team}\u0000${target.linear.project ?? ""}`;
    return yield* readLock.withPermits(1)(
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const cached = cache.get(key);
        if (options?.refresh !== true && cached && now - cached.readAtMs < FRESH_FOR_MS) {
          return { status: "ready", board: cached.board, failure: null } satisfies BoardSnapshot;
        }
        const outcome = yield* fetchBoard(credential.apiKey, target.linear).pipe(
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

  const refresh: Board["Service"]["refresh"] = Effect.fn("Board.refresh")(function* (projectId) {
    // A catalog edit, such as a new `linear` field, should count on the next refresh.
    yield* teamCatalog.refresh();
    const snapshot = yield* read(projectId, { refresh: true });
    yield* PubSub.publish(boardSignals, projectId);
    return snapshot;
  });

  const changes: Board["Service"]["changes"] = (projectId) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(boardSignals);
        return Stream.concat(
          Stream.make(projectId),
          Stream.fromSubscription(subscription).pipe(
            Stream.filter((signal) => signal === null || signal === projectId),
          ),
        ).pipe(Stream.mapEffect(() => read(projectId)));
      }),
    );

  const setCredential = Effect.fn("Board.setCredential")(function* (
    credential: StoredCredential | null,
  ) {
    if (credential === null) {
      yield* secrets.remove(CREDENTIAL_SECRET_NAME).pipe(Effect.orDie);
    } else {
      yield* secrets
        .set(CREDENTIAL_SECRET_NAME, new TextEncoder().encode(encodeCredential(credential)))
        .pipe(Effect.orDie);
    }
    cache.clear();
    const connection = toConnection(credential);
    yield* SubscriptionRef.set(connectionState, connection);
    yield* PubSub.publish(boardSignals, null);
    return connection;
  });

  const connect: Board["Service"]["connect"] = Effect.fn("Board.connect")(function* (rawKey) {
    const apiKey = rawKey.trim();
    const data = yield* linear(apiKey, VIEWER_QUERY, {}, ViewerData);
    return yield* setCredential({
      apiKey,
      viewer: {
        id: data.viewer.id,
        name: data.viewer.name,
        email: data.viewer.email,
        workspace: data.organization.name,
      },
    });
  });

  return Board.of({
    connection: SubscriptionRef.get(connectionState),
    connectionChanges: SubscriptionRef.changes(connectionState),
    connect,
    disconnect: setCredential(null),
    read,
    changes,
    refresh,
  });
});

export const layer = Layer.effect(Board, make);
