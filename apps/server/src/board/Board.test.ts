import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  type BoardSnapshot,
  ProjectId,
  type RepositoryIdentity,
  type TeamCatalogSnapshot,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as TeamCatalog from "../teamCatalog/TeamCatalog.ts";
import * as Board from "./Board.ts";
import { LINEAR_API_URL } from "./linearBoard.ts";

const PROJECT_ID = ProjectId.make("project-web");
const GOOD_KEY = "lin_api_good";
const OTHER_KEY = "lin_api_other";

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
  updatedAt: "2026-11-14T10:00:00.000Z",
  sortOrder: Number(id),
  state: { id: stateId },
  assignee: null,
  labels: { nodes: [] },
  attachments: { nodes: [] },
});

interface Answer {
  readonly status?: number;
  readonly body: unknown;
  readonly headers?: Record<string, string>;
}

/** A Linear stand-in: answers each GraphQL operation by name and records what it was asked. */
const fakeLinear = (
  answer: (
    operation: string,
    variables: Record<string, unknown>,
    apiKey: string,
  ) => Answer | Effect.Effect<Answer>,
) => {
  const calls: Array<{ operation: string; variables: Record<string, unknown> }> = [];
  const client = HttpClient.make((request) =>
    Effect.gen(function* () {
      expect(request.url).toBe(LINEAR_API_URL);
      const body = JSON.parse(
        request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "{}",
      ) as { query: string; variables: Record<string, unknown> };
      const operation = /query (\w+)/.exec(body.query)?.[1] ?? "";
      calls.push({ operation, variables: body.variables });
      const apiKey = request.headers.authorization ?? "";
      if (apiKey !== GOOD_KEY && apiKey !== OTHER_KEY) {
        return HttpClientResponse.fromWeb(
          request,
          Response.json(
            {
              errors: [
                {
                  message: "Authentication required, not authenticated",
                  extensions: { code: "AUTHENTICATION_ERROR" },
                },
              ],
            },
            { status: 400 },
          ),
        );
      }
      const answered = answer(operation, body.variables, apiKey);
      const result = Effect.isEffect(answered) ? yield* answered : answered;
      return HttpClientResponse.fromWeb(
        request,
        Response.json(result.body, {
          status: result.status ?? 200,
          ...(result.headers === undefined ? {} : { headers: result.headers }),
        }),
      );
    }),
  );
  return { client, calls };
};

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

const connected = (
  test: (board: Board.Board["Service"]) => Effect.Effect<void, never, Scope.Scope>,
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
    yield* board.connect(GOOD_KEY);
    yield* test(board);
  }).pipe(Effect.scoped);

const ready = (snapshot: BoardSnapshot) => {
  expect(snapshot.status).toBe("ready");
  return snapshot.status === "ready" ? snapshot : null;
};

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))("Board", (it) => {
  it.effect("stores an accepted key in the secret store and removes it on disconnect", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const secrets = yield* buildSecrets();
      const linear = fakeLinear(boardAnswers([[]]));
      const { secretsDir } = Context.get(secrets, ServerConfig.ServerConfig);
      const secretFile = path.join(secretsDir, `${Board.CREDENTIAL_SECRET_NAME}.bin`);
      const board = yield* makeBoard({ client: linear.client, catalog: catalog([]), secrets });

      expect(yield* board.connection).toEqual({ status: "disconnected" });
      const rejected = yield* Effect.flip(board.connect("lin_api_wrong"));
      expect(rejected).toMatchObject({ _tag: "BoardError", reason: "unauthorized" });
      expect(yield* fileSystem.exists(secretFile)).toBe(false);

      const viewer = {
        id: "user-1",
        name: "Dana Kim",
        email: "dana@example.com",
        workspace: "Acme",
      };
      expect(yield* board.connect(`  ${GOOD_KEY}\n`)).toEqual({ status: "connected", viewer });
      expect((yield* fileSystem.stat(secretFile)).mode & 0o777).toBe(0o600);
      expect(JSON.parse(yield* fileSystem.readFileString(secretFile))).toEqual({
        apiKey: GOOD_KEY,
        viewer,
      });

      // A restarted server reads the connection back without asking Linear.
      const restarted = yield* makeBoard({
        client: HttpClient.make(() => Effect.die("must not ask Linear")),
        catalog: catalog([]),
        secrets,
      });
      expect(yield* restarted.connection).toEqual({ status: "connected", viewer });

      expect(yield* restarted.disconnect).toEqual({ status: "disconnected" });
      expect(yield* fileSystem.exists(secretFile)).toBe(false);
      expect(yield* restarted.read(PROJECT_ID)).toEqual({ status: "not-connected" });
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
      yield* board.connect(GOOD_KEY);
      expect(yield* board.read(PROJECT_ID)).toMatchObject({ reason: "no-linear-team" });
      expect((yield* board.refresh(PROJECT_ID)).status).toBe("ready");
    }).pipe(Effect.scoped),
  );

  it.effect("never serves a board read with the previous key once another key connects", () =>
    Effect.gen(function* () {
      const reading = yield* Deferred.make<void>();
      const released = yield* Deferred.make<void>();
      const linear = fakeLinear((operation, variables, apiKey) => {
        const answered = boardAnswers([[linearIssue(apiKey === GOOD_KEY ? "1" : "2", "s-todo")]])(
          operation,
          variables,
        );
        return operation === "BoardIssues" && apiKey === GOOD_KEY
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
      yield* board.connect(GOOD_KEY);
      const previous = yield* board.read(PROJECT_ID).pipe(Effect.forkChild);
      yield* Deferred.await(reading);
      yield* board.connect(OTHER_KEY);
      yield* Deferred.succeed(released, undefined);
      yield* Fiber.join(previous);

      const snapshot = ready(yield* board.read(PROJECT_ID));
      expect(
        snapshot?.board.columns.flatMap((column) => column.issues.map((issue) => issue.identifier)),
      ).toEqual(["ENG-2"]);
    }).pipe(Effect.scoped),
  );

  it.effect("an open board never shows a refresh read with a key since disconnected", () =>
    Effect.gen(function* () {
      const reading = yield* Deferred.make<void>();
      const released = yield* Deferred.make<void>();
      let hold = false;
      const linear = fakeLinear((operation, variables, apiKey) => {
        const answered = boardAnswers([[linearIssue(apiKey === GOOD_KEY ? "1" : "2", "s-todo")]])(
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
      yield* board.connect(GOOD_KEY);
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

      yield* board.connect(OTHER_KEY);
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
      yield* board.connect(GOOD_KEY);
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
});
