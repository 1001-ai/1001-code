import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  type OrchestrationV2ThreadShell,
  ProjectId,
  type RuntimeMode,
  type TeamCatalogSnapshot,
} from "@t3tools/contracts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import { expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as TeamCatalog from "../teamCatalog/TeamCatalog.ts";
import * as Board from "./Board.ts";
import * as LinearInbox from "./LinearInbox.ts";
import type { InboxData, LinearComment } from "./linearInboxRouting.ts";

const ME = "user-me";

const entry = (key: string, team: string | null) => ({
  file: `projects/${key}.json`,
  project: {
    key,
    name: key,
    repo: `github.com/acme/${key}`,
    owners: [],
    ...(team === null ? {} : { linear: { team } }),
  },
  cloneUrl: `git@github.com:acme/${key}.git`,
  checkout: { path: `/projects/${key}`, state: "present" as const },
  reachable: null,
});

const catalog: TeamCatalogSnapshot = {
  source: "git@github.com:acme/catalog.git",
  defaultSource: null,
  revision: "abc",
  fetchedAt: null,
  refreshing: false,
  error: null,
  projects: [entry("web", "COD"), entry("api", "COD"), entry("docs", null)],
  invalid: [],
  viewer: { login: null, problem: null },
};

const lawrenceComment = (
  id: string,
  createdAt: string,
  body = "agent: proposal",
): LinearComment => ({
  id,
  body,
  createdAt,
  user: { id: "user-lawrence", name: "Lawrence Smith", displayName: "Lawrence" },
  botActor: null,
  externalUser: null,
  parent: null,
  issue: {
    identifier: "COD-2",
    state: { type: "started" },
    attachments: {
      nodes: [
        {
          url: "t3-thread://v2/env-me/thread-mine",
          createdAt: "1970-01-01T00:00:00.000Z",
          creator: { id: ME },
        },
      ],
    },
  },
});

/** A server with one Linear team and one local Claude thread whose mode a test can change. */
const makeInbox = (baseDir: string, comments: Array<LinearComment>) => {
  const sent: Array<ThreadManagement.ThreadManagementSendInput> = [];
  /** How many of the next thread reads and sends fail. */
  const failures = { shellReads: 0, sends: 0 };
  const thread = {
    runtimeMode: "auto" as RuntimeMode,
    latestUserAuthoredMessageAt: null as DateTime.Utc | null,
  };
  const layer = LinearInbox.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(Board.Board)({
          session: Effect.succeed({
            viewerId: ME,
            query: ((_query: string, variables: Record<string, unknown>) =>
              Effect.sync((): InboxData => {
                // Like Linear: newest first, here one comment per page.
                const fresh = comments
                  .filter((c) => c.createdAt > String(variables["since"]))
                  .toSorted((a, b) => b.createdAt.localeCompare(a.createdAt));
                const page = variables["after"] === null ? 0 : Number(variables["after"]);
                return {
                  teams: { nodes: [{ members: { nodes: [{ id: ME }, { id: "user-lawrence" }] } }] },
                  comments: {
                    nodes: fresh.slice(page, page + 1),
                    pageInfo: { hasNextPage: page + 1 < fresh.length, endCursor: String(page + 1) },
                  },
                };
              })) as Board.BoardLinearSession["query"],
          }),
        }),
        Layer.mock(TeamCatalog.TeamCatalog)({ snapshot: Effect.succeed(catalog) }),
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadShell: (threadId) =>
            failures.shellReads-- > 0
              ? Effect.fail(new Orchestrator.OrchestratorProjectionError({ threadId }))
              : Effect.succeed(
                  threadId === "thread-mine"
                    ? ({
                        projectId: ProjectId.make("project-web"),
                        providerInstanceId: "claude",
                        updatedAt: DateTime.makeUnsafe(0),
                        archivedAt: null,
                        ...thread,
                      } as unknown as OrchestrationV2ThreadShell)
                    : null,
                ),
          sendToThread: (input) =>
            failures.sends-- > 0
              ? Effect.fail(
                  new ThreadManagement.ThreadManagementThreadNotFoundError({
                    projectId: input.projectId,
                    threadId: input.threadId,
                  }),
                )
              : Effect.sync(() => {
                  sent.push(input);
                  return { delivery: "started" } as ThreadManagement.ThreadManagementSendResult;
                }),
        }),
        Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
          getInstance: () => Effect.succeed({ driverKind: "claudeAgent" } as ProviderInstance),
        }),
        Layer.mock(ServerEnvironment.ServerEnvironment)({
          getEnvironmentId: Effect.succeed(EnvironmentId.make("env-me")),
        }),
        ServerConfig.layerTest(process.cwd(), baseDir),
      ),
    ),
  );
  // Each poll builds the service again, as a restart would.
  const poll = LinearInbox.LinearInbox.pipe(
    Effect.flatMap((inbox) => inbox.poll),
    Effect.provide(layer),
  );
  return { poll, sent, thread, failures };
};

const tempBaseDir = FileSystem.FileSystem.pipe(
  Effect.flatMap((fileSystem) =>
    fileSystem.makeTempDirectoryScoped({ prefix: "t3-linear-inbox-" }),
  ),
);

it.effect(
  "delivers a teammate's agent comment once, labelled, and keeps its place over restarts",
  () =>
    Effect.gen(function* () {
      const comments = [lawrenceComment("comment-1", "2026-11-15T12:00:00.000Z")];
      const inbox = makeInbox(yield* tempBaseDir, comments);

      yield* inbox.poll;
      expect(inbox.sent).toEqual([]);

      yield* inbox.poll;
      yield* inbox.poll;
      expect(inbox.sent).toHaveLength(1);
      expect(inbox.sent[0]).toMatchObject({
        projectId: "project-web",
        threadId: "thread-mine",
        commandId: "linear-inbox:thread-mine:comment-1",
        messageId: "linear-inbox:thread-mine:comment-1",
        linkedSender: {
          environmentId: "linear",
          threadId: "linear-comment-comment-1",
          title: "Lawrence's agent",
        },
        mode: "queue",
        createdBy: "agent",
        creationSource: "mcp",
      });
      expect(inbox.sent[0]!.text).toMatch(
        /^\[Linear comment ([0-9a-f]{8}) on COD-2 from Lawrence's agent\]\nagent: proposal\n\[End of Linear comment \1\. /,
      );
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.effect("holds a comment for a full-access thread until the user sends there", () =>
  Effect.gen(function* () {
    const inbox = makeInbox(yield* tempBaseDir, [
      lawrenceComment("comment-1", "2026-11-15T12:00:00.000Z"),
    ]);
    inbox.thread.runtimeMode = "full-access";

    yield* inbox.poll;
    yield* inbox.poll;
    yield* inbox.poll;
    expect(inbox.sent).toEqual([]);

    inbox.thread.latestUserAuthoredMessageAt = DateTime.makeUnsafe(1_000);
    yield* inbox.poll;
    yield* inbox.poll;
    expect(inbox.sent.map((input) => input.commandId)).toEqual([
      "linear-inbox:thread-mine:comment-1",
    ]);
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.effect("stops at the daily limit for a thread, counting what earlier runs delivered", () =>
  Effect.gen(function* () {
    const baseDir = yield* tempBaseDir;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfig.ServerConfig.pipe(
      Effect.provide(ServerConfig.layerTest(process.cwd(), baseDir)),
    );
    yield* fileSystem.writeFileString(
      path.join(config.stateDir, "linear-inbox.json"),
      JSON.stringify({
        cursors: { COD: "1970-01-01T00:00:00.000Z" },
        delivered: { "thread-mine": Array.from({ length: 11 }, () => "1970-01-01T00:00:00.000Z") },
        held: [],
      }),
    );
    const inbox = makeInbox(baseDir, [
      lawrenceComment("comment-1", "2026-11-15T12:00:00.000Z", "Can you take the cursor file?"),
      lawrenceComment("comment-2", "2026-11-15T12:01:00.000Z", "And the dedupe?"),
    ]);

    yield* inbox.poll;
    expect(inbox.sent.map((input) => input.commandId)).toEqual([
      "linear-inbox:thread-mine:comment-1",
    ]);
    expect(inbox.sent[0]!.linkedSender?.title).toBe("Lawrence");
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.effect(
  "reads a comment again after its thread could not be read, and retries a failed delivery",
  () =>
    Effect.gen(function* () {
      const inbox = makeInbox(yield* tempBaseDir, [
        lawrenceComment("comment-1", "2026-11-15T12:00:00.000Z"),
      ]);
      yield* inbox.poll;

      inbox.failures.shellReads = 1;
      yield* inbox.poll;
      expect(inbox.sent).toEqual([]);

      inbox.failures.sends = 1;
      yield* inbox.poll;
      expect(inbox.sent).toEqual([]);

      yield* inbox.poll;
      yield* inbox.poll;
      expect(inbox.sent.map((input) => input.commandId)).toEqual([
        "linear-inbox:thread-mine:comment-1",
      ]);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);
