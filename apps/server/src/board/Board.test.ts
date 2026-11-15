import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  type BoardSnapshot,
  ProjectId,
  type RepositoryIdentity,
  type TeamCatalogSnapshot,
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
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as TeamCatalog from "../teamCatalog/TeamCatalog.ts";
import * as Board from "./Board.ts";
import { LINEAR_API_URL } from "./linearBoard.ts";
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
  assignee: null,
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
      const operation = /query (\w+)/.exec(body.query)?.[1] ?? "";
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
) =>
  Effect.gen(function* () {
    const linear = fakeLinear(answer);
    const board = yield* makeBoard({
      client: linear.client,
      catalog: catalogSnapshot,
      secrets: yield* buildSecrets(),
    });
    yield* signIn(board, linear);
    yield* test(board, linear);
  }).pipe(Effect.scoped);

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
    const detail = (id: string, teamId: string) => ({
      body: {
        data: {
          issue: {
            id,
            team: { id: teamId },
            project: null,
            description: "Fix the **login** flow.",
            creator: {
              id: "u1",
              name: "Dana Kim",
              displayName: "dana",
              avatarUrl: null,
              isMe: true,
            },
          },
        },
      },
    });
    const answer = boardAnswers([[linearIssue("1", "s-todo")]]);
    return connected(
      (board, linear) =>
        Effect.gen(function* () {
          expect(yield* board.issueDetail({ projectId: PROJECT_ID, issueId: "1" })).toEqual({
            description: "Fix the **login** flow.",
            creator: { id: "u1", name: "dana", avatarUrl: null, isMe: true },
          });
          expect(
            linear.calls.find((call) => call.operation === "BoardIssueDetail")?.variables,
          ).toEqual({ id: "1" });
          expect(
            yield* board.issueDetail({ projectId: PROJECT_ID, issueId: "9" }).pipe(Effect.flip),
          ).toMatchObject({ reason: "issue-not-found" });
        }).pipe(Effect.orDie),
      (operation, variables) =>
        operation === "BoardIssueDetail"
          ? detail(String(variables.id), variables.id === "9" ? "team-2" : team.id)
          : answer(operation, variables),
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
});
