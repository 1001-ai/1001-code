import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  type BoardSnapshot,
  EnvironmentId,
  type OrchestrationV2ThreadShell,
  ProjectId,
  type RepositoryIdentity,
  type TeamCatalogSnapshot,
  ThreadId,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, type HttpClientRequest, HttpClientResponse } from "effect/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as TeamCatalog from "../teamCatalog/TeamCatalog.ts";
import * as Board from "./Board.ts";
import { LINEAR_API_URL, VIEWER_QUERY, ViewerData } from "./linearBoard.ts";
import { LINEAR_REVOKE_URL, LINEAR_TOKEN_URL } from "./linearOAuth.ts";

const PROJECT_ID = ProjectId.make("project-web");
const CLIENT_ID = "client-test";
const ORIGIN = "https://env.example.test";
const GOOD = "good";
const OTHER = "other";

const identity: RepositoryIdentity = {
  canonicalKey: "github.com/acme/web",
  locator: { source: "git-remote", remoteName: "origin", remoteUrl: "git@github.com:acme/web.git" },
};

const catalogEntry = (linear: { team: string; project?: string } | undefined) => ({
  file: "projects/web.json",
  project: {
    key: "web",
    name: "Web",
    repo: "github.com/acme/web",
    owners: [],
    ...(linear === undefined ? {} : { linear }),
  },
  cloneUrl: "git@github.com:acme/web.git",
  checkout: { path: "/projects/web", state: "present" as const },
  reachable: null,
});

const catalog = (
  projects: TeamCatalogSnapshot["projects"],
  source: string | null = "git@github.com:acme/catalog.git",
): TeamCatalogSnapshot => ({
  source,
  defaultSource: null,
  revision: "abc",
  fetchedAt: null,
  refreshing: false,
  error: null,
  projects,
  invalid: [],
  viewer: { login: null, problem: null },
});

const team = {
  id: "team-1",
  key: "ENG",
  name: "Engineering",
  states: {
    nodes: [
      { id: "s-done", name: "Done", type: "completed", color: "#5e6ad2", position: 1 },
      { id: "s-todo", name: "Todo", type: "unstarted", color: "#e2e2e2", position: 0 },
    ],
  },
};

const linearIssue = (id: string, stateId: string) => ({
  id,
  identifier: `ENG-${id}`,
  title: `Issue ${id}`,
  url: `https://linear.app/acme/issue/ENG-${id}`,
  priority: 0,
  createdAt: "2026-11-13T10:00:00.000Z",
  startedAt: null,
  updatedAt: "2026-11-14T10:00:00.000Z",
  sortOrder: Number(id),
  state: { id: stateId },
  assignee: null as {
    id: string;
    name: string;
    displayName: string;
    avatarUrl: string | null;
    isMe: boolean;
  } | null,
  labels: { nodes: [] },
  threadLinks: { nodes: [] },
  attachments: { nodes: [] },
});

interface Answer {
  readonly status?: number;
  readonly body: unknown;
  readonly headers?: Record<string, string>;
}

const json = (request: HttpClientRequest.HttpClientRequest, body: unknown, status = 200) =>
  HttpClientResponse.fromWeb(request, Response.json(body, { status }));

/**
 * A response whose body is already read, so a woken poll runs to its next sleep without waiting on
 * a promise and `TestClock.adjust` returns only once it has.
 */
const readyResponse = (
  request: HttpClientRequest.HttpClientRequest,
  body: unknown,
  init: ResponseInit,
): HttpClientResponse.HttpClientResponse =>
  Object.create(HttpClientResponse.fromWeb(request, new Response(null, init)), {
    json: { value: Effect.succeed(body) },
  });

const formBody = (request: HttpClientRequest.HttpClientRequest) =>
  Object.fromEntries(
    new URLSearchParams(
      request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "",
    ),
  );

/**
 * A Linear stand-in: its OAuth endpoints issue rotating tokens for an account (a code's account is
 * set by `authorize`), and its GraphQL endpoint answers each operation by name for that account.
 */
const fakeLinear = (
  answer: (
    operation: string,
    variables: Record<string, unknown>,
    account: string,
  ) => Answer | Effect.Effect<Answer>,
  /** Runs before the token endpoint answers, to hold or observe a refresh. */
  beforeToken: (params: Record<string, string>) => Effect.Effect<void> = () => Effect.void,
) => {
  const calls: Array<{
    operation: string;
    variables: Record<string, unknown>;
    account: string | undefined;
  }> = [];
  const tokenCalls: Array<Record<string, string>> = [];
  const revoked: Array<Record<string, string>> = [];
  const codes = new Map<string, { account: string; challenge: string }>();
  const accessTokens = new Map<string, string>();
  const refreshTokens = new Map<string, string>();
  let issued = 0;
  const issue = (account: string) => {
    issued += 1;
    const tokens = {
      access_token: `access-${account}-${issued}`,
      refresh_token: `refresh-${account}-${issued}`,
    };
    accessTokens.set(tokens.access_token, account);
    refreshTokens.set(tokens.refresh_token, account);
    return { ...tokens, token_type: "Bearer", expires_in: 86_399, scope: "read write" };
  };
  const client = HttpClient.make((request) =>
    Effect.gen(function* () {
      if (request.url === LINEAR_TOKEN_URL) {
        const params = formBody(request);
        tokenCalls.push(params);
        yield* beforeToken(params);
        if (params.client_id !== CLIENT_ID) return json(request, { error: "invalid_client" }, 401);
        if (params.grant_type === "authorization_code") {
          const pending = codes.get(params.code ?? "");
          codes.delete(params.code ?? "");
          const digest = yield* Effect.promise(() =>
            crypto.subtle.digest("SHA-256", new TextEncoder().encode(params.code_verifier ?? "")),
          );
          const verified =
            pending !== undefined && Base64Url.encode(new Uint8Array(digest)) === pending.challenge;
          return verified
            ? json(request, issue(pending.account))
            : json(request, { error: "invalid_grant" }, 400);
        }
        const account = refreshTokens.get(params.refresh_token ?? "");
        if (account === undefined) return json(request, { error: "invalid_grant" }, 400);
        refreshTokens.delete(params.refresh_token ?? "");
        return json(request, issue(account));
      }
      if (request.url === LINEAR_REVOKE_URL) {
        const params = formBody(request);
        revoked.push(params);
        accessTokens.delete(params.token ?? "");
        refreshTokens.delete(params.token ?? "");
        return json(request, {});
      }
      expect(request.url).toBe(LINEAR_API_URL);
      const body = JSON.parse(
        request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "{}",
      ) as { query: string; variables: Record<string, unknown> };
      const operation = /(?:query|mutation) (\w+)/.exec(body.query)?.[1] ?? "";
      const account = accessTokens.get(
        (request.headers.authorization ?? "").replace(/^Bearer /u, ""),
      );
      calls.push({ operation, variables: body.variables, account });
      if (account === undefined) {
        return json(
          request,
          {
            errors: [
              {
                message: "Authentication required, not authenticated",
                extensions: { code: "AUTHENTICATION_ERROR" },
              },
            ],
          },
          400,
        );
      }
      const answered = answer(operation, body.variables, account);
      const result = Effect.isEffect(answered) ? yield* answered : answered;
      return readyResponse(request, result.body, {
        status: result.status ?? 200,
        ...(result.headers === undefined ? {} : { headers: result.headers }),
      });
    }),
  );
  return {
    client,
    calls,
    tokenCalls,
    revoked,
    /** Linear's consent screen: the code it would redirect back with for this account. */
    authorize: (authorizeUrl: string, account: string) => {
      const url = new URL(authorizeUrl);
      const code = `code-${account}-${codes.size + 1}`;
      codes.set(code, { account, challenge: url.searchParams.get("code_challenge") ?? "" });
      return { code, state: url.searchParams.get("state") };
    },
    /** As if the person revoked the app in Linear's settings. */
    revokeAll: () => {
      accessTokens.clear();
      refreshTokens.clear();
    },
    revokeAccessTokens: () => accessTokens.clear(),
  };
};

type FakeLinear = ReturnType<typeof fakeLinear>;

const viewerAnswer: Answer = {
  body: {
    data: {
      viewer: { id: "user-1", name: "Dana Kim", email: "dana@example.com" },
      organization: { name: "Acme" },
    },
  },
};

const boardAnswers =
  (pages: ReadonlyArray<ReadonlyArray<ReturnType<typeof linearIssue>>>, teams = [team]) =>
  (operation: string, variables: Record<string, unknown>): Answer => {
    if (operation === "BoardViewer") return viewerAnswer;
    if (operation === "BoardTeam") return { body: { data: { teams: { nodes: teams } } } };
    const page = variables.after === null ? 0 : Number(variables.after);
    return {
      body: {
        data: {
          issues: {
            nodes: pages[page] ?? [],
            pageInfo: {
              hasNextPage: page + 1 < pages.length,
              endCursor: page + 1 < pages.length ? String(page + 1) : null,
            },
          },
        },
      },
    };
  };

const makeBoard = (input: {
  readonly client: HttpClient.HttpClient;
  /** The OAuth client id; unset means sign-in is not configured. */
  readonly clientId?: string | null;
  readonly catalog: TeamCatalogSnapshot;
  /** What a forced catalog fetch finds; an unforced one keeps the catalog it has. */
  readonly fetchedCatalog?: TeamCatalogSnapshot;
  readonly secrets: Context.Context<
    ServerSecretStore.ServerSecretStore | ServerConfig.ServerConfig
  >;
  readonly threads?: Partial<ThreadManagement.ThreadManagementService["Service"]>;
}) => {
  let current = input.catalog;
  return Board.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(HttpClient.HttpClient, input.client),
        Layer.succeed(
          HostProcess.Environment,
          input.clientId === null ? {} : { [Board.CLIENT_ID_ENV]: input.clientId ?? CLIENT_ID },
        ),
        Layer.mock(TeamCatalog.TeamCatalog)({
          snapshot: Effect.sync(() => current),
          refresh: (refreshInput) =>
            Effect.sync(() => {
              if (refreshInput?.force === true) current = input.fetchedCatalog ?? current;
              return current;
            }),
        }),
        Layer.mock(ProjectStore.ProjectStoreV2)({
          get: () =>
            Effect.succeedSome({
              projectId: PROJECT_ID,
              title: "Web",
              workspaceRoot: "/projects/web",
            } as unknown as ProjectStore.ProjectRow),
        }),
        Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({
          resolve: () => Effect.succeed(identity),
        }),
        Layer.mock(ThreadManagement.ThreadManagementService)(input.threads ?? {}),
        Layer.mock(ServerEnvironment.ServerEnvironment)({
          getEnvironmentId: Effect.succeed(EnvironmentId.make("env-me")),
        }),
        Layer.succeedContext(input.secrets),
      ),
    ),
    Layer.build,
    Effect.map((context) => Context.get(context, Board.Board)),
  );
};

/** A secret store in a fresh temp T3 home, shared by every board built from it. */
const buildSecrets = () =>
  Layer.build(
    ServerSecretStore.layer.pipe(
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-board-test-" })),
    ),
  );

/** A secret store in memory, so a poll never waits on the file system. */
const memorySecrets = () => {
  const stored = new Map<string, Uint8Array>();
  return Layer.build(
    Layer.mergeAll(
      Layer.mock(ServerSecretStore.ServerSecretStore)({
        get: (name) => Effect.sync(() => Option.fromNullishOr(stored.get(name))),
        set: (name, value) => Effect.sync(() => void stored.set(name, value)),
        remove: (name) => Effect.sync(() => void stored.delete(name)),
      }),
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-board-test-" }),
    ),
  );
};

/** Signs in through Linear's consent screen as `account`, as a person in a browser would. */
const signIn = (board: Board.Board["Service"], linear: FakeLinear, account = GOOD) =>
  Effect.gen(function* () {
    const { authorizeUrl } = yield* board.startSignIn(ORIGIN);
    const { code, state } = linear.authorize(authorizeUrl, account);
    return yield* board.completeSignIn({ state, code, error: null });
  }).pipe(Effect.orDie);

const connected = (
  test: (
    board: Board.Board["Service"],
    linear: FakeLinear,
  ) => Effect.Effect<void, never, Scope.Scope>,
  answer: Parameters<typeof fakeLinear>[0],
  catalogSnapshot = catalog([catalogEntry({ team: "ENG" })]),
  threads?: Partial<ThreadManagement.ThreadManagementService["Service"]>,
) =>
  Effect.gen(function* () {
    const linear = fakeLinear(answer);
    const board = yield* makeBoard({
      client: linear.client,
      catalog: catalogSnapshot,
      secrets: yield* buildSecrets(),
      ...(threads === undefined ? {} : { threads }),
    });
    yield* signIn(board, linear);
    yield* test(board, linear);
  }).pipe(Effect.scoped);

const linearComment = (
  id: string,
  createdAt: string,
  body: string,
  author: { user?: string; bot?: string },
  parent: string | null = null,
) => ({
  id,
  body,
  createdAt,
  parent: parent === null ? null : { id: parent },
  user:
    author.user === undefined ? null : { name: `${author.user} Full`, displayName: author.user },
  botActor: author.bot === undefined ? null : { name: author.bot },
  externalUser: null,
});

/** An issue's detail; `linked` adds my link to a thread here among links that must not count. */
const detailAnswer = (id: string, teamId: string, linked = true): Answer => ({
  body: {
    data: {
      issue: {
        id,
        identifier: `ENG-${id}`,
        team: { id: teamId },
        project: null,
        description: "Fix the **login** flow.",
        creator: { id: "u1", name: "Dana Kim", displayName: "dana", avatarUrl: null, isMe: true },
        threadLinks: {
          nodes: [
            ...(linked
              ? [
                  {
                    url: "t3-thread://v2/env-me/thread-mine",
                    createdAt: "2026-11-14T08:00:00.000Z",
                    creator: { id: "user-1" },
                  },
                ]
              : []),
            {
              url: "t3-thread://v2/env-me/thread-forged",
              createdAt: "2026-11-14T09:00:00.000Z",
              creator: { id: "user-2" },
            },
          ],
        },
        // Newest first, as Linear lists them.
        comments: {
          nodes: [
            linearComment("c-3", "2026-11-14T11:00:00.000Z", "Linked a pull request.", {
              bot: "GitHub",
            }),
            // A reply to a reply, which Linear's API allows; it belongs under the root.
            linearComment(
              "c-4",
              "2026-11-14T10:30:00.000Z",
              "Thanks.",
              { user: "Lawrence" },
              "c-2",
            ),
            linearComment(
              "c-2",
              "2026-11-14T10:00:00.000Z",
              "agent: accept — on it.",
              { user: "dana" },
              "c-1",
            ),
            linearComment("c-1", "2026-11-14T09:00:00.000Z", "Can you take this?", {
              user: "Lawrence",
            }),
          ],
        },
      },
    },
  },
});

const THREAD = { id: ThreadId.make("thread-mine"), title: "Fix login" };

/** The team with a started state and the catalog's project, as agents' task tools read it. */
const taskTeam = {
  ...team,
  states: {
    nodes: [
      ...team.states.nodes,
      { id: "s-progress", name: "In Progress", type: "started", color: "#f2c94c", position: 0 },
    ],
  },
  projects: {
    nodes: [{ id: "project-1", slugId: "abc123", name: "Web", url: "https://linear.app/p/web" }],
  },
};

const calls = (linear: FakeLinear, operation: string) =>
  linear.calls.filter((call) => call.operation === operation);

const members = [
  { id: "user-1", name: "Dana Kim", displayName: "dana", email: "dana@example.com" },
  { id: "user-2", name: "Lawrence Ade", displayName: "Lawrence", email: "lawrence@acme.test" },
  { id: "user-3", name: "Sam Lee", displayName: "sam", email: "sam.lee@acme.test" },
  { id: "user-4", name: "Sam Park", displayName: "sam", email: "sam.park@acme.test" },
];

const STATES: Record<string, { name: string; type: string }> = {
  "s-todo": { name: "Todo", type: "unstarted" },
  "s-done": { name: "Done", type: "completed" },
  "s-progress": { name: "In Progress", type: "started" },
};

/**
 * Linear for the task tools: ENG-1 carries the viewer's link to this thread, ENG-2 only someone
 * else's, OPS-3 is on another team. Updates echo the issue with the given fields applied.
 */
const taskAnswers = (operation: string, variables: Record<string, unknown>): Answer => {
  const task = (identifier: string) => ({
    id: `id-${identifier}`,
    identifier,
    title: "Fix login",
    url: `https://linear.app/acme/issue/${identifier}`,
    state: STATES["s-todo"]!,
    assignee: null,
    project: null,
  });
  if (operation === "BoardTask") {
    const identifier = String(variables.id);
    return {
      body: {
        data: {
          issue: {
            ...task(identifier),
            team: { id: identifier.startsWith("OPS") ? "team-ops" : team.id },
            threadLinks: {
              nodes: [
                {
                  url: "t3-thread://v2/env-me/thread-mine",
                  creator: { id: identifier === "ENG-1" ? "user-1" : "user-2" },
                },
              ],
            },
          },
        },
      },
    };
  }
  if (operation === "BoardIssueUpdate") {
    const input = variables.input as { title?: string; stateId?: string; assigneeId?: string };
    const member = members.find((candidate) => candidate.id === input.assigneeId);
    const identifier = String(variables.id).slice("id-".length);
    return {
      body: {
        data: {
          issueUpdate: {
            success: true,
            issue: {
              ...task(identifier),
              ...(input.title === undefined ? {} : { title: input.title }),
              ...(input.stateId === undefined ? {} : { state: STATES[input.stateId]! }),
              ...(member === undefined ? {} : { assignee: member }),
            },
          },
        },
      },
    };
  }
  if (operation === "BoardThreadLink") {
    return { body: { data: { attachmentCreate: { success: true } } } };
  }
  if (operation === "BoardTeamMembers") {
    return { body: { data: { team: { members: { nodes: members } } } } };
  }
  return boardAnswers([[]], [taskTeam])(operation, variables);
};

const ready = (snapshot: BoardSnapshot) => {
  expect(snapshot.status).toBe("ready");
  return snapshot.status === "ready" ? snapshot : null;
};

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))("Board", (it) => {
  it.effect(
    "signs in with PKCE, stores the tokens, and on disconnect forgets and revokes them",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const secrets = yield* buildSecrets();
        const linear = fakeLinear(boardAnswers([[]]));
        const { secretsDir } = Context.get(secrets, ServerConfig.ServerConfig);
        const secretFile = path.join(secretsDir, `${Board.CREDENTIAL_SECRET_NAME}.bin`);
        const board = yield* makeBoard({ client: linear.client, catalog: catalog([]), secrets });
        expect(yield* board.connection).toEqual({ status: "disconnected" });

        const { authorizeUrl } = yield* board.startSignIn(`${ORIGIN}/settings/threads`);
        const url = new URL(authorizeUrl);
        expect(`${url.origin}${url.pathname}`).toBe("https://linear.app/oauth/authorize");
        expect(Object.fromEntries(url.searchParams)).toEqual({
          client_id: CLIENT_ID,
          redirect_uri: `${ORIGIN}/oauth/linear/callback`,
          response_type: "code",
          scope: "read,write",
          state: expect.stringMatching(/^[\w-]{43}$/u),
          code_challenge: expect.stringMatching(/^[\w-]{43}$/u),
          code_challenge_method: "S256",
          prompt: "consent",
        });

        const { code, state } = linear.authorize(authorizeUrl, GOOD);
        const viewer = {
          id: "user-1",
          name: "Dana Kim",
          email: "dana@example.com",
          workspace: "Acme",
        };
        expect(yield* board.completeSignIn({ state, code, error: null })).toEqual(viewer);
        // A public PKCE client: the exchange carries the verifier and never a client secret.
        expect(linear.tokenCalls).toEqual([
          {
            grant_type: "authorization_code",
            code,
            redirect_uri: `${ORIGIN}/oauth/linear/callback`,
            client_id: CLIENT_ID,
            code_verifier: expect.stringMatching(/^[\w-]{43}$/u),
          },
        ]);
        expect(yield* board.connection).toEqual({ status: "connected", viewer });
        expect((yield* fileSystem.stat(secretFile)).mode & 0o777).toBe(0o600);
        expect(JSON.parse(yield* fileSystem.readFileString(secretFile))).toEqual({
          accessToken: "access-good-1",
          refreshToken: "refresh-good-1",
          expiresAt: 86_399_000,
          viewer,
        });

        // A restarted server reads the connection back without asking Linear.
        const restarted = yield* makeBoard({
          client: linear.client,
          catalog: catalog([]),
          secrets,
        });
        expect(yield* restarted.connection).toEqual({ status: "connected", viewer });
        expect(linear.calls).toHaveLength(1);

        expect(yield* restarted.disconnect).toEqual({ status: "disconnected" });
        expect(yield* fileSystem.exists(secretFile)).toBe(false);
        expect(linear.revoked).toEqual([
          { token: "refresh-good-1", token_type_hint: "refresh_token" },
          { token: "access-good-1", token_type_hint: "access_token" },
        ]);
        expect(yield* restarted.read(PROJECT_ID)).toEqual({ status: "not-connected" });
      }).pipe(Effect.scoped),
  );

  it.effect("finishes a sign-in only for a fresh state it issued, once", () =>
    Effect.gen(function* () {
      const linear = fakeLinear(boardAnswers([[]]));
      const board = yield* makeBoard({
        client: linear.client,
        catalog: catalog([]),
        secrets: yield* buildSecrets(),
      });
      const failure = (params: Parameters<Board.Board["Service"]["completeSignIn"]>[0]) =>
        board.completeSignIn(params).pipe(
          Effect.flip,
          Effect.map((error) => error.message),
        );
      const expired =
        "This sign-in link has expired or was already used. Start again from Settings → Board.";

      const first = linear.authorize((yield* board.startSignIn(ORIGIN)).authorizeUrl, GOOD);
      expect(yield* failure({ state: "forged", code: first.code, error: null })).toBe(expired);
      expect(yield* failure({ state: null, code: first.code, error: null })).toBe(expired);
      expect(yield* failure({ state: first.state, code: null, error: "access_denied" })).toBe(
        "Linear sign-in was cancelled.",
      );
      // Settings shows it until the next sign-in starts; a stray callback does not change it.
      expect(yield* board.connection).toEqual({
        status: "disconnected",
        signInFailure: "Linear sign-in was cancelled.",
      });
      // The cancelled state is spent.
      expect(yield* failure({ ...first, error: null })).toBe(expired);

      // Only the newest attempt's failure is shown, whatever order the callbacks arrive in.
      const older = linear.authorize((yield* board.startSignIn(ORIGIN)).authorizeUrl, GOOD);
      const newer = linear.authorize((yield* board.startSignIn(ORIGIN)).authorizeUrl, GOOD);
      yield* failure({ state: older.state, code: null, error: "access_denied" });
      expect(yield* board.connection).toEqual({ status: "disconnected" });
      yield* failure({ state: newer.state, code: null, error: "server_error" });
      expect(yield* board.connection).toEqual({
        status: "disconnected",
        signInFailure: "Linear did not complete the sign-in (server_error).",
      });

      const late = linear.authorize((yield* board.startSignIn(ORIGIN)).authorizeUrl, GOOD);
      expect(yield* board.connection).toEqual({ status: "disconnected" });
      yield* TestClock.adjust("11 minutes");
      expect(yield* failure({ ...late, error: null })).toBe(expired);

      const wrongCode = linear.authorize((yield* board.startSignIn(ORIGIN)).authorizeUrl, GOOD);
      expect(yield* failure({ state: wrongCode.state, code: "code-stolen", error: null })).toBe(
        "Linear did not accept this sign-in. Start again from Settings → Board.",
      );

      expect(linear.tokenCalls).toHaveLength(1);
      expect(yield* board.connection).toEqual({
        status: "disconnected",
        signInFailure: "Linear did not accept this sign-in. Start again from Settings → Board.",
      });
    }).pipe(Effect.scoped),
  );

  it.effect("is unavailable without a client id, and drops an unreadable old credential", () =>
    Effect.gen(function* () {
      const secrets = yield* buildSecrets();
      const store = Context.get(secrets, ServerSecretStore.ServerSecretStore);
      yield* store.set(
        Board.CREDENTIAL_SECRET_NAME,
        new TextEncoder().encode(JSON.stringify({ apiKey: "lin_api_old", viewer: {} })),
      );
      const linear = fakeLinear(boardAnswers([[]]));
      const board = yield* makeBoard({
        client: linear.client,
        catalog: catalog([catalogEntry({ team: "ENG" })]),
        secrets,
        clientId: null,
      });
      expect(yield* store.get(Board.CREDENTIAL_SECRET_NAME)).toEqual(Option.none());
      expect(yield* board.connection).toEqual({ status: "unavailable" });
      expect(yield* Effect.flip(board.startSignIn(ORIGIN))).toMatchObject({
        reason: "sign-in-unavailable",
      });
      expect(yield* board.read(PROJECT_ID)).toEqual({ status: "not-connected" });
    }).pipe(Effect.scoped),
  );

  it.effect("refreshes the access token before it expires and when Linear rejects it", () =>
    connected(
      (board, linear) =>
        Effect.gen(function* () {
          expect(ready(yield* board.read(PROJECT_ID))).not.toBeNull();
          expect(linear.tokenCalls).toHaveLength(1);

          yield* TestClock.adjust("1436 minutes");
          expect(ready(yield* board.read(PROJECT_ID, { refresh: true }))).not.toBeNull();
          expect(linear.tokenCalls.slice(1)).toEqual([
            { grant_type: "refresh_token", refresh_token: "refresh-good-1", client_id: CLIENT_ID },
          ]);

          linear.revokeAccessTokens();
          expect(ready(yield* board.read(PROJECT_ID, { refresh: true }))).not.toBeNull();
          expect(linear.tokenCalls.slice(2)).toEqual([
            { grant_type: "refresh_token", refresh_token: "refresh-good-2", client_id: CLIENT_ID },
          ]);
          expect(yield* board.connection).toMatchObject({ status: "connected" });
        }),
      boardAnswers([[linearIssue("1", "s-todo")]]),
    ),
  );

  it.effect("signs out when Linear no longer honors the refresh token", () =>
    connected(
      (board, linear) =>
        Effect.gen(function* () {
          linear.revokeAll();
          expect(yield* board.read(PROJECT_ID)).toMatchObject({
            status: "failed",
            failure: { reason: "unauthorized" },
          });
          expect(yield* board.connection).toEqual({ status: "disconnected" });
          expect(yield* board.read(PROJECT_ID)).toEqual({ status: "not-connected" });
        }),
      boardAnswers([[linearIssue("1", "s-todo")]]),
    ),
  );

  it.effect("stores a refresh even when the read that started it is interrupted", () =>
    Effect.gen(function* () {
      const refreshing = yield* Deferred.make<void>();
      const released = yield* Deferred.make<void>();
      const linear = fakeLinear(boardAnswers([[linearIssue("1", "s-todo")]]), (params) =>
        params.grant_type === "refresh_token"
          ? Deferred.succeed(refreshing, undefined).pipe(Effect.andThen(Deferred.await(released)))
          : Effect.void,
      );
      const secrets = yield* buildSecrets();
      const board = yield* makeBoard({
        client: linear.client,
        catalog: catalog([catalogEntry({ team: "ENG" })]),
        secrets,
      });
      yield* signIn(board, linear);
      yield* TestClock.adjust("1436 minutes");
      const reading = yield* board.read(PROJECT_ID).pipe(Effect.forkChild);
      yield* Deferred.await(refreshing);
      const interrupting = yield* Fiber.interrupt(reading).pipe(Effect.forkChild);
      yield* Deferred.succeed(released, undefined);
      yield* Fiber.join(interrupting);

      const stored = yield* Context.get(secrets, ServerSecretStore.ServerSecretStore).get(
        Board.CREDENTIAL_SECRET_NAME,
      );
      expect(
        JSON.parse(new TextDecoder().decode(Option.getOrThrow(stored))) as unknown,
      ).toMatchObject({ accessToken: "access-good-2", refreshToken: "refresh-good-2" });
      expect(ready(yield* board.read(PROJECT_ID))).not.toBeNull();
      expect(linear.tokenCalls).toHaveLength(2);
    }).pipe(Effect.scoped),
  );

  it.effect("revokes the tokens of a sign-in it cannot keep", () =>
    Effect.gen(function* () {
      let viewerFails = true;
      const holding = yield* Deferred.make<void>();
      const released = yield* Deferred.make<void>();
      const linear = fakeLinear((operation, variables, account) => {
        if (operation !== "BoardViewer") return boardAnswers([[]])(operation, variables);
        if (viewerFails) return { status: 500, body: { errors: [] } };
        return account === OTHER
          ? Deferred.succeed(holding, undefined).pipe(
              Effect.andThen(Deferred.await(released)),
              Effect.as(viewerAnswer),
            )
          : viewerAnswer;
      });
      const board = yield* makeBoard({
        client: linear.client,
        catalog: catalog([]),
        secrets: yield* buildSecrets(),
      });

      // Linear granted access but the viewer could not be read.
      const first = linear.authorize((yield* board.startSignIn(ORIGIN)).authorizeUrl, GOOD);
      yield* Effect.flip(board.completeSignIn({ ...first, error: null }));
      expect(linear.revoked.map((call) => call.token)).toEqual(["refresh-good-1", "access-good-1"]);
      viewerFails = false;

      // A disconnect while a sign-in finishes wins, and revokes that sign-in.
      yield* signIn(board, linear);
      const second = linear.authorize((yield* board.startSignIn(ORIGIN)).authorizeUrl, OTHER);
      const finishing = yield* board
        .completeSignIn({ ...second, error: null })
        .pipe(Effect.flip, Effect.forkChild);
      yield* Deferred.await(holding);
      expect(yield* board.disconnect).toEqual({ status: "disconnected" });
      yield* Deferred.succeed(released, undefined);
      expect((yield* Fiber.join(finishing)).message).toContain("disconnected or signed in again");
      expect(linear.revoked.slice(2).map((call) => call.token)).toEqual([
        "refresh-good-2",
        "access-good-2",
        "refresh-other-3",
        "access-other-3",
      ]);
      expect(yield* board.connection).toMatchObject({ status: "disconnected" });
    }).pipe(Effect.scoped),
  );

  it.effect("a Linear tab opened before Disconnect cannot sign back in", () =>
    Effect.gen(function* () {
      const linear = fakeLinear(boardAnswers([[]]));
      const board = yield* makeBoard({
        client: linear.client,
        catalog: catalog([]),
        secrets: yield* buildSecrets(),
      });
      const open = linear.authorize((yield* board.startSignIn(ORIGIN)).authorizeUrl, GOOD);
      yield* board.disconnect;
      expect(
        (yield* Effect.flip(board.completeSignIn({ ...open, error: null }))).message,
      ).toContain("expired or was already used");
      expect(yield* board.connection).toEqual({ status: "disconnected" });
    }).pipe(Effect.scoped),
  );

  it.effect("says why a project has no board", () =>
    Effect.gen(function* () {
      const cases = [
        [catalog([], null), { reason: "no-catalog", catalogFile: null }],
        [
          catalog([
            {
              ...catalogEntry(undefined),
              project: { ...catalogEntry(undefined).project, repo: "github.com/acme/api" },
            },
          ]),
          { reason: "not-in-catalog", catalogFile: null },
        ],
        [
          catalog([catalogEntry(undefined)]),
          { reason: "no-linear-team", catalogFile: "projects/web.json" },
        ],
      ] as const;
      for (const [catalogSnapshot, expected] of cases) {
        yield* connected(
          (board) =>
            Effect.gen(function* () {
              expect(yield* board.read(PROJECT_ID)).toEqual({
                status: "unconfigured",
                ...expected,
              });
            }),
          boardAnswers([[]]),
          catalogSnapshot,
        );
      }
    }),
  );

  it.effect("refreshes the catalog itself, so a Linear team just added to it counts", () =>
    Effect.gen(function* () {
      const linear = fakeLinear(boardAnswers([[linearIssue("1", "s-todo")]]));
      const board = yield* makeBoard({
        client: linear.client,
        catalog: catalog([catalogEntry(undefined)]),
        fetchedCatalog: catalog([catalogEntry({ team: "ENG" })]),
        secrets: yield* buildSecrets(),
      });
      yield* signIn(board, linear);
      expect(yield* board.read(PROJECT_ID)).toMatchObject({ reason: "no-linear-team" });
      expect((yield* board.refresh(PROJECT_ID)).status).toBe("ready");
    }).pipe(Effect.scoped),
  );

  it.effect("never serves a board read made before another account signed in", () =>
    Effect.gen(function* () {
      const reading = yield* Deferred.make<void>();
      const released = yield* Deferred.make<void>();
      const linear = fakeLinear((operation, variables, account) => {
        const answered = boardAnswers(
          account === GOOD
            ? [[linearIssue("1", "s-todo")], [linearIssue("3", "s-todo")]]
            : [[linearIssue("2", "s-todo")]],
        )(operation, variables);
        return operation === "BoardIssues" && account === GOOD
          ? Deferred.succeed(reading, undefined).pipe(
              Effect.andThen(Deferred.await(released)),
              Effect.as(answered),
            )
          : answered;
      });
      const board = yield* makeBoard({
        client: linear.client,
        catalog: catalog([catalogEntry({ team: "ENG" })]),
        secrets: yield* buildSecrets(),
      });
      yield* signIn(board, linear);
      const session = yield* board.session;
      const previous = yield* board.read(PROJECT_ID).pipe(Effect.forkChild);
      yield* Deferred.await(reading);
      yield* signIn(board, linear, OTHER);
      yield* Deferred.succeed(released, undefined);
      expect((yield* Fiber.join(previous)).status).toBe("failed");
      // The read stopped instead of fetching its second page as the other account.
      expect(linear.calls.filter((call) => call.variables.after === "1")).toEqual([]);

      const snapshot = ready(yield* board.read(PROJECT_ID));
      expect(
        snapshot?.board.columns.flatMap((column) => column.issues.map((issue) => issue.identifier)),
      ).toEqual(["ENG-2"]);
      // A session never queries as the account that signed in after it was taken.
      const stale = yield* Effect.flip(session!.query(VIEWER_QUERY, {}, ViewerData));
      expect(stale.reason).toBe("unauthorized");
    }).pipe(Effect.scoped),
  );

  it.effect("an open board never shows a refresh read with a sign-in since disconnected", () =>
    Effect.gen(function* () {
      const reading = yield* Deferred.make<void>();
      const released = yield* Deferred.make<void>();
      let hold = false;
      const linear = fakeLinear((operation, variables, account) => {
        const answered = boardAnswers([[linearIssue(account === GOOD ? "1" : "2", "s-todo")]])(
          operation,
          variables,
        );
        return operation === "BoardIssues" && hold
          ? Deferred.succeed(reading, undefined).pipe(
              Effect.andThen(Deferred.await(released)),
              Effect.as(answered),
            )
          : answered;
      });
      const board = yield* makeBoard({
        client: linear.client,
        catalog: catalog([catalogEntry({ team: "ENG" })]),
        secrets: yield* buildSecrets(),
      });
      yield* signIn(board, linear);
      const updates = yield* Queue.unbounded<BoardSnapshot>();
      yield* board.changes(PROJECT_ID).pipe(
        Stream.runForEach((snapshot) => Queue.offer(updates, snapshot)),
        Effect.forkScoped,
      );
      ready(yield* Queue.take(updates));

      hold = true;
      const refreshing = yield* board.refresh(PROJECT_ID).pipe(Effect.forkChild);
      yield* Deferred.await(reading);
      hold = false;
      yield* board.disconnect;
      yield* Deferred.succeed(released, undefined);
      expect((yield* Fiber.join(refreshing)).status).toBe("not-connected");

      yield* signIn(board, linear, OTHER);
      const seen: Array<string> = [];
      while (!seen.includes("ENG-2")) {
        const snapshot = yield* Queue.take(updates);
        seen.push(
          snapshot.status === "ready"
            ? snapshot.board.columns
                .flatMap((column) => column.issues.map((issue) => issue.identifier))
                .join()
            : snapshot.status,
        );
      }
      expect(seen).toEqual(["not-connected", "ENG-2"]);
    }).pipe(Effect.scoped),
  );

  it.effect("reads every page of the team's issues into its columns, then serves the cache", () => {
    const answer = boardAnswers([
      [linearIssue("1", "s-todo"), linearIssue("2", "s-done")],
      [linearIssue("3", "s-todo")],
    ]);
    const linear = fakeLinear(answer);
    return Effect.gen(function* () {
      const board = yield* makeBoard({
        client: linear.client,
        catalog: catalog([catalogEntry({ team: "ENG" })]),
        secrets: yield* buildSecrets(),
      });
      yield* signIn(board, linear);
      const snapshot = ready(yield* board.read(PROJECT_ID));
      expect(snapshot?.board.team).toEqual({ id: "team-1", key: "ENG", name: "Engineering" });
      expect(
        snapshot?.board.columns.map((column) => [
          column.state.name,
          column.issues.map((issue) => issue.identifier),
        ]),
      ).toEqual([
        ["Todo", ["ENG-1", "ENG-3"]],
        ["Done", ["ENG-2"]],
      ]);
      expect(snapshot?.board.truncated).toBe(false);
      const team = linear.calls.find((call) => call.operation === "BoardTeam");
      expect(team?.variables).toEqual({ key: "ENG", project: "", withProject: false });
      expect(linear.calls.filter((call) => call.operation === "BoardIssues")).toHaveLength(2);

      yield* board.read(PROJECT_ID);
      expect(linear.calls.filter((call) => call.operation === "BoardTeam")).toHaveLength(1);
      yield* board.read(PROJECT_ID, { refresh: true });
      expect(linear.calls.filter((call) => call.operation === "BoardTeam")).toHaveLength(2);
    }).pipe(Effect.scoped);
  });

  it.effect("reports a missing team or project", () =>
    Effect.gen(function* () {
      yield* connected(
        (board) =>
          Effect.gen(function* () {
            expect(yield* board.read(PROJECT_ID)).toMatchObject({
              status: "failed",
              failure: { reason: "team-not-found" },
            });
          }),
        boardAnswers([[]], []),
      );
      yield* connected(
        (board) =>
          Effect.gen(function* () {
            expect(yield* board.read(PROJECT_ID)).toMatchObject({
              status: "failed",
              failure: { reason: "project-not-found" },
            });
          }),
        boardAnswers([[]], [{ ...team, projects: { nodes: [] } }] as never),
        catalog([catalogEntry({ team: "ENG", project: "Checkout" })]),
      );
    }),
  );

  it.effect("reads an issue's detail only when the issue is on the project's board", () => {
    const answer = boardAnswers([[linearIssue("1", "s-todo")]]);
    return connected(
      (board, linear) =>
        Effect.gen(function* () {
          expect(yield* board.issueDetail({ projectId: PROJECT_ID, issueId: "1" })).toEqual({
            description: "Fix the **login** flow.",
            creator: { id: "u1", name: "dana", avatarUrl: null, isMe: true },
            comments: [
              {
                id: "c-1",
                body: "Can you take this?",
                author: "Lawrence",
                createdAt: "2026-11-14T09:00:00.000Z",
                agent: false,
                replies: [
                  {
                    id: "c-2",
                    body: "agent: accept — on it.",
                    author: "dana",
                    createdAt: "2026-11-14T10:00:00.000Z",
                    agent: true,
                  },
                  {
                    id: "c-4",
                    body: "Thanks.",
                    author: "Lawrence",
                    createdAt: "2026-11-14T10:30:00.000Z",
                    agent: false,
                  },
                ],
              },
              {
                id: "c-3",
                body: "Linked a pull request.",
                author: "GitHub",
                createdAt: "2026-11-14T11:00:00.000Z",
                agent: false,
                replies: [],
              },
            ],
            linkedThreadId: "thread-mine",
          });
          expect(
            linear.calls.find((call) => call.operation === "BoardIssueDetail")?.variables,
          ).toEqual({ id: "1" });
          expect(
            yield* board.issueDetail({ projectId: PROJECT_ID, issueId: "9" }).pipe(Effect.flip),
          ).toMatchObject({ reason: "issue-not-found" });
          expect(
            yield* board.issueDetail({ projectId: PROJECT_ID, issueId: "gone" }).pipe(Effect.flip),
          ).toMatchObject({ reason: "issue-not-found" });
        }).pipe(Effect.orDie),
      (operation, variables) =>
        operation !== "BoardIssueDetail"
          ? answer(operation, variables)
          : variables.id === "gone"
            ? { body: { data: { issue: null } } }
            : detailAnswer(String(variables.id), variables.id === "9" ? "team-2" : team.id),
      undefined,
      {
        getThreadShell: (threadId) =>
          Effect.succeed(threadId === "thread-mine" ? ({} as OrchestrationV2ThreadShell) : null),
      },
    );
  });

  it.effect("posts a comment as the signed-in person, then queues it in the linked thread", () => {
    const answer = boardAnswers([[linearIssue("1", "s-todo")]]);
    const sent: Array<ThreadManagement.ThreadManagementSendInput> = [];
    const threads: Partial<ThreadManagement.ThreadManagementService["Service"]> = {
      getThreadShell: (threadId) =>
        Effect.succeed(
          threadId === "thread-mine"
            ? ({ projectId: ProjectId.make("project-thread") } as OrchestrationV2ThreadShell)
            : null,
        ),
      sendToThread: (input) =>
        Effect.sync(() => {
          sent.push(input);
          return {} as ThreadManagement.ThreadManagementSendResult;
        }),
    };
    return connected(
      (board, linear) =>
        Effect.gen(function* () {
          const posts = () => linear.calls.filter((call) => call.operation === "BoardComment");
          expect(
            yield* board.comment({
              projectId: PROJECT_ID,
              issueId: "1",
              body: "On it.",
              parentId: "c-1",
            }),
          ).toEqual({ threadId: "thread-mine" });
          expect(posts().map((call) => call.variables)).toEqual([
            { input: { issueId: "1", body: "On it.", parentId: "c-1" } },
          ]);
          expect(posts()[0]?.account).toBe(GOOD);
          expect(sent).toEqual([
            expect.objectContaining({
              projectId: "project-thread",
              threadId: "thread-mine",
              commandId: "board-comment:thread-mine:c-new",
              text: "I replied to Lawrence's comment on ENG-1 in Linear:\n\nOn it.",
              mode: "queue",
              createdBy: "user",
            }),
          ]);

          // No linked thread: Linear only.
          expect(
            yield* board.comment({ projectId: PROJECT_ID, issueId: "2", body: "Linear only." }),
          ).toEqual({ threadId: null });
          expect(posts()).toHaveLength(2);
          expect(sent).toHaveLength(1);

          // Linear refuses: no thread hears of it.
          expect(
            yield* board
              .comment({ projectId: PROJECT_ID, issueId: "3", body: "Refused." })
              .pipe(Effect.flip),
          ).toMatchObject({ reason: "invalid-response" });
          expect(sent).toHaveLength(1);
        }).pipe(Effect.orDie),
      (operation, variables) => {
        if (operation === "BoardIssueDetail") {
          return detailAnswer(String(variables.id), team.id, variables.id !== "2");
        }
        if (operation === "BoardComment") {
          const input = variables.input as { issueId: string };
          return {
            body: {
              data: {
                commentCreate:
                  input.issueId === "3"
                    ? { success: false, comment: { id: "c-refused" } }
                    : { success: true, comment: { id: "c-new" } },
              },
            },
          };
        }
        return answer(operation, variables);
      },
      undefined,
      threads,
    );
  });

  it.effect("keeps the last board when Linear rate-limits a refresh", () => {
    let limited = false;
    const answer = (operation: string, variables: Record<string, unknown>): Answer =>
      limited && operation !== "BoardViewer"
        ? {
            status: 400,
            body: { errors: [{ message: "Rate limited", extensions: { code: "RATELIMITED" } }] },
            headers: { "retry-after": "60" },
          }
        : boardAnswers([[linearIssue("1", "s-todo")]])(operation, variables);
    return connected(
      (board) =>
        Effect.gen(function* () {
          const updates = yield* Queue.unbounded<BoardSnapshot>();
          yield* board.changes(PROJECT_ID).pipe(
            Stream.runForEach((snapshot) => Queue.offer(updates, snapshot)),
            Effect.forkScoped,
          );
          const first = ready(yield* Queue.take(updates));
          limited = true;
          const limitedSnapshot = {
            status: "ready",
            board: first?.board,
            failure: {
              reason: "rate-limited",
              detail: "Linear's rate limit was reached. Try again later.",
              retryAfterSeconds: 60,
            },
          };
          expect(yield* board.refresh(PROJECT_ID)).toEqual(limitedSnapshot);
          // The open board gets the warning too, though its cached read is still fresh.
          expect(yield* Queue.take(updates)).toEqual(limitedSnapshot);
        }),
      answer,
    );
  });

  it.effect("fails a first read Linear rate-limits, and a read with a revoked key", () =>
    Effect.gen(function* () {
      yield* connected(
        (board) =>
          Effect.gen(function* () {
            expect(yield* board.read(PROJECT_ID)).toMatchObject({
              status: "failed",
              failure: { reason: "rate-limited", retryAfterSeconds: 30 },
            });
          }),
        (operation, variables) =>
          operation === "BoardViewer"
            ? viewerAnswer
            : operation === "BoardIssues"
              ? { status: 429, body: { errors: [] }, headers: { "retry-after": "30" } }
              : boardAnswers([[]])(operation, variables),
      );
      yield* connected(
        (board) =>
          Effect.gen(function* () {
            expect(yield* board.read(PROJECT_ID)).toMatchObject({
              status: "failed",
              failure: { reason: "unauthorized" },
            });
          }),
        (operation) =>
          operation === "BoardViewer" ? viewerAnswer : { status: 401, body: { errors: [] } },
      );
    }),
  );

  it.effect("an open board reads Linear every 30 seconds, once for all its viewers", () =>
    Effect.gen(function* () {
      let issues = [linearIssue("1", "s-todo")];
      const linear = fakeLinear((operation, variables) =>
        boardAnswers([issues])(operation, variables),
      );
      const board = yield* makeBoard({
        client: linear.client,
        catalog: catalog([catalogEntry({ team: "ENG" })]),
        // A poll does not fetch the catalog; a forced fetch would find no Linear team.
        fetchedCatalog: catalog([catalogEntry(undefined)]),
        secrets: yield* memorySecrets(),
      });
      yield* signIn(board, linear);
      const teamReads = () => linear.calls.filter((call) => call.operation === "BoardTeam").length;
      const open = Effect.gen(function* () {
        const scope = yield* Scope.make();
        const updates = yield* Queue.unbounded<BoardSnapshot>();
        yield* board.changes(PROJECT_ID).pipe(
          Stream.runForEach((snapshot) => Queue.offer(updates, snapshot)),
          Effect.forkIn(scope),
        );
        ready(yield* Queue.take(updates));
        return { scope, updates };
      });
      const identifiers = (snapshot: BoardSnapshot) =>
        ready(snapshot)?.board.columns.flatMap((column) =>
          column.issues.map((issue) => issue.identifier),
        );

      const first = yield* open;
      const second = yield* open;
      expect(teamReads()).toBe(1);

      yield* TestClock.adjust("30 seconds");
      expect(teamReads()).toBe(2);
      expect(yield* Queue.size(first.updates)).toBe(0);
      expect(yield* Queue.size(second.updates)).toBe(0);

      issues = [linearIssue("1", "s-todo"), linearIssue("2", "s-todo")];
      yield* TestClock.adjust("30 seconds");
      expect(teamReads()).toBe(3);
      expect(identifiers(yield* Queue.take(first.updates))).toEqual(["ENG-1", "ENG-2"]);
      expect(identifiers(yield* Queue.take(second.updates))).toEqual(["ENG-1", "ENG-2"]);

      yield* Scope.close(first.scope, Exit.void);
      yield* TestClock.adjust("30 seconds");
      expect(teamReads()).toBe(4);
      yield* Scope.close(second.scope, Exit.void);
      yield* TestClock.adjust("5 minutes");
      expect(teamReads()).toBe(4);
    }).pipe(Effect.scoped),
  );

  it.effect("an agent's burst of Linear writes reads each open board once, a second later", () =>
    Effect.gen(function* () {
      let issues = [linearIssue("1", "s-todo")];
      const linear = fakeLinear((operation, variables) =>
        boardAnswers([issues])(operation, variables),
      );
      const board = yield* makeBoard({
        client: linear.client,
        catalog: catalog([catalogEntry({ team: "ENG" })]),
        secrets: yield* memorySecrets(),
      });
      yield* signIn(board, linear);
      const teamReads = () => linear.calls.filter((call) => call.operation === "BoardTeam").length;
      const scope = yield* Scope.make();
      const updates = yield* Queue.unbounded<BoardSnapshot>();
      yield* board.changes(PROJECT_ID).pipe(
        Stream.runForEach((snapshot) => Queue.offer(updates, snapshot)),
        Effect.forkIn(scope),
      );
      ready(yield* Queue.take(updates));
      expect(teamReads()).toBe(1);

      issues = [linearIssue("1", "s-todo"), linearIssue("2", "s-todo")];
      yield* board.refreshOpen;
      yield* board.refreshOpen;
      yield* TestClock.adjust("500 millis");
      yield* board.refreshOpen;
      expect(teamReads()).toBe(1);
      yield* TestClock.adjust("500 millis");
      expect(
        ready(yield* Queue.take(updates))?.board.columns.flatMap((column) =>
          column.issues.map((issue) => issue.identifier),
        ),
      ).toEqual(["ENG-1", "ENG-2"]);
      expect(teamReads()).toBe(2);
      yield* TestClock.adjust("2 seconds");
      expect(teamReads()).toBe(2);

      yield* Scope.close(scope, Exit.void);
      yield* board.refreshOpen;
      yield* TestClock.adjust("2 seconds");
      expect(teamReads()).toBe(2);
    }).pipe(Effect.scoped),
  );

  it.effect("polling keeps the board through a rate limit and waits as long as Linear asks", () =>
    Effect.gen(function* () {
      let limited = false;
      const linear = fakeLinear((operation, variables) =>
        limited && operation !== "BoardViewer"
          ? { status: 429, body: { errors: [] }, headers: { "retry-after": "120" } }
          : boardAnswers([[linearIssue("1", "s-todo")]])(operation, variables),
      );
      const board = yield* makeBoard({
        client: linear.client,
        catalog: catalog([catalogEntry({ team: "ENG" })]),
        secrets: yield* memorySecrets(),
      });
      yield* signIn(board, linear);
      const teamReads = () => linear.calls.filter((call) => call.operation === "BoardTeam").length;
      const updates = yield* Queue.unbounded<BoardSnapshot>();
      yield* board.changes(PROJECT_ID).pipe(
        Stream.runForEach((snapshot) => Queue.offer(updates, snapshot)),
        Effect.forkScoped,
      );
      const shown = ready(yield* Queue.take(updates))?.board;

      limited = true;
      yield* TestClock.adjust("30 seconds");
      expect(yield* Queue.take(updates)).toEqual({
        status: "ready",
        board: shown,
        failure: {
          reason: "rate-limited",
          detail: "Linear's rate limit was reached. Try again later.",
          retryAfterSeconds: 120,
        },
      });
      expect(teamReads()).toBe(2);

      yield* TestClock.adjust("90 seconds");
      expect(teamReads()).toBe(2);
      yield* TestClock.adjust("30 seconds");
      expect(teamReads()).toBe(3);
      expect(yield* Queue.size(updates)).toBe(0);

      limited = false;
      yield* TestClock.adjust("120 seconds");
      expect(yield* Queue.take(updates)).toMatchObject({ status: "ready", failure: null });
    }).pipe(Effect.scoped),
  );

  it.effect("polling waits out a rate limit a refresh saw, then clears its warning", () =>
    Effect.gen(function* () {
      let limited = false;
      const linear = fakeLinear((operation, variables) =>
        limited && operation !== "BoardViewer"
          ? { status: 429, body: { errors: [] }, headers: { "retry-after": "120" } }
          : boardAnswers([[linearIssue("1", "s-todo")]])(operation, variables),
      );
      const board = yield* makeBoard({
        client: linear.client,
        catalog: catalog([catalogEntry({ team: "ENG" })]),
        secrets: yield* memorySecrets(),
      });
      yield* signIn(board, linear);
      const teamReads = () => linear.calls.filter((call) => call.operation === "BoardTeam").length;
      const updates = yield* Queue.unbounded<BoardSnapshot>();
      yield* board.changes(PROJECT_ID).pipe(
        Stream.runForEach((snapshot) => Queue.offer(updates, snapshot)),
        Effect.forkScoped,
      );
      ready(yield* Queue.take(updates));

      limited = true;
      yield* board.refresh(PROJECT_ID);
      expect(yield* Queue.take(updates)).toMatchObject({
        status: "ready",
        failure: { reason: "rate-limited", retryAfterSeconds: 120 },
      });
      expect(teamReads()).toBe(2);

      limited = false;
      yield* TestClock.adjust("90 seconds");
      expect(teamReads()).toBe(2);
      yield* TestClock.adjust("30 seconds");
      expect(teamReads()).toBe(3);
      expect(yield* Queue.take(updates)).toMatchObject({ status: "ready", failure: null });
    }).pipe(Effect.scoped),
  );

  it.effect("a poll after a rate-limited refresh asks Linear, not the cache", () =>
    Effect.gen(function* () {
      let limited = false;
      const linear = fakeLinear((operation, variables) =>
        limited && operation !== "BoardViewer"
          ? { status: 429, body: { errors: [] }, headers: { "retry-after": "1" } }
          : boardAnswers([[linearIssue("1", "s-todo")]])(operation, variables),
      );
      const board = yield* makeBoard({
        client: linear.client,
        catalog: catalog([catalogEntry({ team: "ENG" })]),
        secrets: yield* memorySecrets(),
      });
      yield* signIn(board, linear);
      const teamReads = () => linear.calls.filter((call) => call.operation === "BoardTeam").length;
      const updates = yield* Queue.unbounded<BoardSnapshot>();
      yield* board.changes(PROJECT_ID).pipe(
        Stream.runForEach((snapshot) => Queue.offer(updates, snapshot)),
        Effect.forkScoped,
      );
      ready(yield* Queue.take(updates));

      // A successful refresh leaves a fresh cache behind the warning the next one shows.
      yield* TestClock.adjust("20 seconds");
      yield* board.refresh(PROJECT_ID);
      yield* Queue.take(updates);
      yield* TestClock.adjust("5 seconds");
      limited = true;
      yield* board.refresh(PROJECT_ID);
      expect(yield* Queue.take(updates)).toMatchObject({
        failure: { reason: "rate-limited" },
      });
      expect(teamReads()).toBe(3);

      yield* TestClock.adjust("5 seconds");
      expect(teamReads()).toBe(4);
      expect(yield* Queue.size(updates)).toBe(0);
    }).pipe(Effect.scoped),
  );

  it.effect("a board closed during a poll and opened again gets a poll of its own", () =>
    Effect.gen(function* () {
      const reading = yield* Deferred.make<void>();
      const released = yield* Deferred.make<void>();
      let hold = false;
      let issues = [linearIssue("1", "s-todo")];
      const linear = fakeLinear((operation, variables) => {
        const answered = boardAnswers([issues])(operation, variables);
        return operation === "BoardIssues" && hold
          ? Deferred.succeed(reading, undefined).pipe(
              Effect.andThen(Deferred.await(released)),
              Effect.as(answered),
            )
          : answered;
      });
      const board = yield* makeBoard({
        client: linear.client,
        catalog: catalog([catalogEntry({ team: "ENG" })]),
        secrets: yield* memorySecrets(),
      });
      yield* signIn(board, linear);
      const teamReads = () => linear.calls.filter((call) => call.operation === "BoardTeam").length;
      const open = Effect.gen(function* () {
        const scope = yield* Scope.make();
        const updates = yield* Queue.unbounded<BoardSnapshot>();
        yield* board.changes(PROJECT_ID).pipe(
          Stream.runForEach((snapshot) => Queue.offer(updates, snapshot)),
          Effect.forkIn(scope),
        );
        return { scope, updates, first: ready(yield* Queue.take(updates)) };
      });

      const before = yield* open;
      hold = true;
      issues = [linearIssue("2", "s-todo")];
      yield* TestClock.adjust("30 seconds");
      yield* Deferred.await(reading);
      yield* Scope.close(before.scope, Exit.void);

      hold = false;
      issues = [linearIssue("3", "s-todo")];
      const after = yield* open;
      yield* Deferred.succeed(released, undefined);
      expect(
        after.first?.board.columns.flatMap((column) => column.issues.map((i) => i.identifier)),
      ).toEqual(["ENG-3"]);
      expect(teamReads()).toBe(3);

      yield* TestClock.adjust("30 seconds");
      expect(teamReads()).toBe(4);
      expect(yield* Queue.size(after.updates)).toBe(0);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "files a task as the signed-in person, linked to the thread, then reads open boards",
    () =>
      Effect.gen(function* () {
        let created: Array<ReturnType<typeof linearIssue>> = [];
        const linear = fakeLinear((operation, variables) => {
          if (operation === "BoardIssueCreate") {
            created = [linearIssue("7", "s-progress")];
            const input = variables.input as { title: string };
            return {
              body: {
                data: {
                  issueCreate: {
                    success: true,
                    issue: {
                      id: "issue-new",
                      identifier: "ENG-7",
                      title: input.title,
                      url: "https://linear.app/acme/issue/ENG-7",
                      state: { name: "In Progress", type: "started" },
                      assignee: { name: "Dana Kim", displayName: "dana" },
                      project: { name: "Web" },
                    },
                  },
                },
              },
            };
          }
          if (operation === "BoardThreadLink") {
            return { body: { data: { attachmentCreate: { success: true } } } };
          }
          return boardAnswers([created], [taskTeam])(operation, variables);
        });
        const board = yield* makeBoard({
          client: linear.client,
          catalog: catalog([catalogEntry({ team: "ENG", project: "Web" })]),
          secrets: yield* memorySecrets(),
        });
        yield* signIn(board, linear);
        const scope = yield* Scope.make();
        const updates = yield* Queue.unbounded<BoardSnapshot>();
        yield* board.changes(PROJECT_ID).pipe(
          Stream.runForEach((snapshot) => Queue.offer(updates, snapshot)),
          Effect.forkIn(scope),
        );
        ready(yield* Queue.take(updates));
        const issueReads = () => calls(linear, "BoardIssues").length;
        expect(issueReads()).toBe(1);

        expect(
          yield* board.addTask({
            projectId: PROJECT_ID,
            thread: THREAD,
            title: "Fix the login flow",
            description: "It loops.",
            status: " in progress ",
            assignee: "Me",
          }),
        ).toEqual({
          task: {
            identifier: "ENG-7",
            title: "Fix the login flow",
            url: "https://linear.app/acme/issue/ENG-7",
            status: { name: "In Progress", type: "started" },
            assignee: "dana",
            project: "Web",
          },
          threadLinked: true,
        });
        expect(calls(linear, "BoardIssueCreate")).toEqual([
          {
            operation: "BoardIssueCreate",
            account: GOOD,
            variables: {
              input: {
                teamId: "team-1",
                projectId: "project-1",
                title: "Fix the login flow",
                description: "It loops.",
                stateId: "s-progress",
                assigneeId: "user-1",
              },
            },
          },
        ]);
        expect(calls(linear, "BoardThreadLink").map((call) => call.variables)).toEqual([
          {
            input: {
              issueId: "issue-new",
              url: "t3-thread://v2/env-me/thread-mine",
              title: "Fix login",
            },
          },
        ]);
        // "me" needs no member lookup.
        expect(calls(linear, "BoardTeamMembers")).toEqual([]);

        yield* TestClock.adjust("1 second");
        expect(
          ready(yield* Queue.take(updates))?.board.columns.flatMap((column) =>
            column.issues.map((issue) => issue.identifier),
          ),
        ).toEqual(["ENG-7"]);
        expect(issueReads()).toBe(2);
        yield* Scope.close(scope, Exit.void);
      }).pipe(Effect.scoped),
  );

  it.effect("updates only the given fields and links the thread once", () =>
    connected(
      (board, linear) =>
        Effect.gen(function* () {
          const update = (identifier: string, fields: Partial<Board.BoardUpdateTaskInput> = {}) =>
            board.updateTask({ projectId: PROJECT_ID, thread: THREAD, identifier, ...fields });

          // Linked here already: one update, no second link.
          const moved = yield* update("ENG-1", { status: "done", assignee: "lawrence@acme.test" });
          expect(moved).toEqual({
            task: expect.objectContaining({
              identifier: "ENG-1",
              status: { name: "Done", type: "completed" },
              assignee: "Lawrence",
            }),
            threadLinked: true,
          });
          expect(calls(linear, "BoardIssueUpdate").map((call) => call.variables)).toEqual([
            { id: "id-ENG-1", input: { stateId: "s-done", assigneeId: "user-2" } },
          ]);
          expect(calls(linear, "BoardThreadLink")).toEqual([]);

          // Nothing to change on a linked task: no write at all.
          expect((yield* update("ENG-1")).task.status).toEqual({ name: "Todo", type: "unstarted" });
          expect(calls(linear, "BoardIssueUpdate")).toHaveLength(1);

          // Only someone else's link to this thread: the viewer's own is added.
          expect(yield* update("ENG-2", { title: "Renamed" })).toMatchObject({
            task: { identifier: "ENG-2", title: "Renamed" },
            threadLinked: true,
          });
          expect(calls(linear, "BoardIssueUpdate")[1]?.variables).toEqual({
            id: "id-ENG-2",
            input: { title: "Renamed" },
          });
          expect(calls(linear, "BoardThreadLink").map((call) => call.variables)).toEqual([
            {
              input: {
                issueId: "id-ENG-2",
                url: "t3-thread://v2/env-me/thread-mine",
                title: "Fix login",
              },
            },
          ]);
        }).pipe(Effect.orDie),
      taskAnswers,
      catalog([catalogEntry({ team: "ENG" })]),
    ),
  );

  it.effect("refuses an unknown status or assignee and a task off the board", () =>
    connected(
      (board, linear) =>
        Effect.gen(function* () {
          const add = (fields: Partial<Board.BoardAddTaskInput>) =>
            board
              .addTask({ projectId: PROJECT_ID, thread: THREAD, title: "Task", ...fields })
              .pipe(Effect.flip);
          expect(yield* add({ status: "Shipped" })).toMatchObject({
            _tag: "BoardInputError",
            detail:
              'The ENG board has no status named "Shipped". Its statuses are Done, Todo, In Progress.',
          });
          expect(yield* add({ assignee: "Robin" })).toMatchObject({
            _tag: "BoardInputError",
            detail:
              'No member of the ENG team is named "Robin". Use "me", or a member\'s name or email.',
          });
          expect(yield* add({ assignee: "sam" })).toMatchObject({
            _tag: "BoardInputError",
            detail: 'More than one member of the ENG team is named "sam". Name them by email.',
          });
          expect(calls(linear, "BoardIssueCreate")).toEqual([]);

          expect(
            yield* board
              .updateTask({ projectId: PROJECT_ID, thread: THREAD, identifier: "OPS-3" })
              .pipe(Effect.flip),
          ).toMatchObject({
            reason: "issue-not-found",
            detail: "OPS-3 is not on this project's board.",
          });
          expect(calls(linear, "BoardIssueUpdate")).toEqual([]);
        }).pipe(Effect.orDie),
      taskAnswers,
    ),
  );

  it.effect("task tools need a sign-in and a board", () =>
    Effect.gen(function* () {
      const linear = fakeLinear(taskAnswers);
      const board = yield* makeBoard({
        client: linear.client,
        catalog: catalog([catalogEntry({ team: "ENG" })]),
        secrets: yield* buildSecrets(),
      });
      const signedOut = {
        reason: "unauthorized",
        detail:
          "Nobody is signed in to Linear here. Ask the user to sign in in Settings → Board, then add the task.",
      };
      expect(
        yield* board
          .addTask({ projectId: PROJECT_ID, thread: THREAD, title: "Task" })
          .pipe(Effect.flip),
      ).toMatchObject(signedOut);
      expect(yield* board.listTasks(PROJECT_ID).pipe(Effect.flip)).toMatchObject({
        reason: "unauthorized",
      });
      expect(linear.calls).toEqual([]);

      yield* connected(
        (unconfigured) =>
          Effect.gen(function* () {
            const noBoard = {
              _tag: "BoardInputError",
              detail:
                "This project's catalog entry (projects/web.json) names no Linear team, so it has no board.",
            };
            expect(
              yield* unconfigured
                .updateTask({ projectId: PROJECT_ID, thread: THREAD, identifier: "ENG-1" })
                .pipe(Effect.flip),
            ).toMatchObject(noBoard);
            expect(yield* unconfigured.listTasks(PROJECT_ID).pipe(Effect.flip)).toMatchObject(
              noBoard,
            );
          }).pipe(Effect.orDie),
        taskAnswers,
        catalog([catalogEntry(undefined)]),
      );
    }).pipe(Effect.scoped),
  );

  it.effect("lists the board's open tasks", () =>
    connected(
      (board) =>
        Effect.gen(function* () {
          expect(yield* board.listTasks(PROJECT_ID)).toEqual({
            tasks: [
              {
                identifier: "ENG-1",
                title: "Issue 1",
                url: "https://linear.app/acme/issue/ENG-1",
                status: { name: "Todo", type: "unstarted" },
                assignee: "dana",
                project: "Web",
              },
              {
                identifier: "ENG-3",
                title: "Issue 3",
                url: "https://linear.app/acme/issue/ENG-3",
                status: { name: "In Progress", type: "started" },
                assignee: null,
                project: "Web",
              },
            ],
            truncated: false,
          });
        }).pipe(Effect.orDie),
      boardAnswers(
        [
          [
            {
              ...linearIssue("1", "s-todo"),
              assignee: {
                id: "user-1",
                name: "Dana Kim",
                displayName: "dana",
                avatarUrl: null,
                isMe: true,
              },
            },
            linearIssue("2", "s-done"),
            linearIssue("3", "s-progress"),
          ],
        ],
        [taskTeam],
      ),
      catalog([catalogEntry({ team: "ENG", project: "Web" })]),
    ),
  );
});
