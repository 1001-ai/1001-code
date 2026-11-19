import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ThreadShell,
  ProjectId,
  type RuntimeMode,
  type TeamCatalogSnapshot,
  ThreadId,
} from "@t3tools/contracts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import { expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import { recordInboxThread } from "../inboxAgent/inboxAgentThreads.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as TeamCatalog from "../teamCatalog/TeamCatalog.ts";
import * as Board from "./Board.ts";
import * as LinearInbox from "./LinearInbox.ts";
import { linearInboxLog } from "./linearInboxLog.ts";
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
  projects: [entry("web", "ENG"), entry("api", "ENG"), entry("docs", null)],
  invalid: [],
  viewer: { login: null, problem: null },
};

const samComment = (
  id: string,
  createdAt: string,
  body = "agent: proposal",
  linked = true,
): LinearComment => ({
  id,
  body,
  url: `https://linear.acme.test/acme/issue/ENG-2#${id}`,
  createdAt,
  user: { id: "user-sam", name: "Sam Lee", displayName: "Sam" },
  botActor: null,
  externalUser: null,
  parent: null,
  issue: {
    id: "issue-2",
    identifier: "ENG-2",
    title: "Poll Linear comments",
    state: { type: "started" },
    assignee: null,
    project: null,
    attachments: {
      nodes: linked
        ? [
            {
              url: "t3-thread://v2/env-me/thread-mine",
              createdAt: "1970-01-01T00:00:00.000Z",
              creator: { id: ME },
            },
          ]
        : [],
    },
  },
});

const WEB = ProjectId.make("project-web");
const INBOX = ThreadId.make("thread-inbox");
/** Threads of the server: the issue's linked one, the web project's Inbox, and two others. */
const PROJECT_OF: Record<string, string> = {
  "thread-mine": "project-web",
  "thread-inbox": "project-web",
  "thread-other": "project-web",
  "thread-away": "project-api",
};

/** A server with one Linear team and local Claude threads; the issue's thread's mode can change. */
const makeInbox = (baseDir: string, comments: Array<LinearComment>) => {
  const sent: Array<ThreadManagement.ThreadManagementSendInput> = [];
  /** The Linear queries made, by kind. */
  const queries: Array<"probe" | "full"> = [];
  const replies: Array<Board.BoardReplyInput> = [];
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
            query: ((query: string, variables: Record<string, unknown>) =>
              Effect.sync((): unknown => {
                if (query.includes("LinearInboxProbe")) {
                  queries.push("probe");
                  const fresh = comments.filter((c) => c.createdAt > String(variables["since"]));
                  return { comments: { nodes: fresh.slice(0, 1).map(({ id }) => ({ id })) } };
                }
                queries.push("full");
                // Like Linear: newest first, here one comment per page.
                const fresh = comments
                  .filter((c) => c.createdAt > String(variables["since"]))
                  .toSorted((a, b) => b.createdAt.localeCompare(a.createdAt));
                const page = variables["after"] === null ? 0 : Number(variables["after"]);
                return {
                  teams: { nodes: [{ members: { nodes: [{ id: ME }, { id: "user-sam" }] } }] },
                  comments: {
                    nodes: fresh.slice(page, page + 1),
                    pageInfo: { hasNextPage: page + 1 < fresh.length, endCursor: String(page + 1) },
                  },
                } satisfies InboxData;
              })) as Board.BoardLinearSession["query"],
          }),
          linearProjects: Effect.succeed([{ projectId: WEB, linear: { team: "ENG" } }]),
          reply: (input) =>
            Effect.sync(() => {
              replies.push(input);
              return { task: input.issue, commentId: "comment-reply" };
            }),
        }),
        Layer.mock(TeamCatalog.TeamCatalog)({ snapshot: Effect.succeed(catalog) }),
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadShell: (threadId) =>
            failures.shellReads-- > 0
              ? Effect.fail(new Orchestrator.OrchestratorProjectionError({ threadId }))
              : Effect.succeed(
                  PROJECT_OF[threadId] !== undefined
                    ? ({
                        id: threadId,
                        projectId: ProjectId.make(PROJECT_OF[threadId]),
                        providerInstanceId: "claude",
                        updatedAt: DateTime.makeUnsafe(0),
                        archivedAt: null,
                        ...thread,
                      } as unknown as OrchestrationV2ThreadShell)
                    : null,
                ),
          // The messages delivered so far, as the thread holds them.
          getThreadRecords: (threadId, _fields, filter) =>
            Effect.succeed({
              messages: sent
                .filter(
                  (input) =>
                    input.threadId === threadId && filter?.messageIds?.includes(input.messageId),
                )
                .map(
                  (input) =>
                    ({
                      id: input.messageId,
                      role: "user",
                      text: input.text,
                      linkedSender: input.linkedSender,
                    }) as OrchestrationV2ConversationMessage,
                ),
            } as never),
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
  // Each use builds the service again, as a restart would.
  const use = <A, E>(f: (inbox: LinearInbox.LinearInbox["Service"]) => Effect.Effect<A, E>) =>
    LinearInbox.LinearInbox.pipe(Effect.flatMap(f), Effect.provide(layer));
  const poll = use((inbox) => inbox.poll);
  return { poll, use, sent, queries, replies, thread, failures };
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
      const comments = [samComment("comment-1", "2026-11-15T12:00:00.000Z")];
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
          title: "Sam Lee's agent",
        },
        mode: "queue",
        createdBy: "agent",
        creationSource: "mcp",
      });
      expect(inbox.sent[0]!.text).toMatch(
        /^\[Linear comment ([0-9a-f]{8}) on ENG-2 from Sam Lee's agent\]\nagent: proposal\n\[End of Linear comment \1\. /,
      );
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.effect(
  "delivers to a full-access thread at once, and what an older version held on the next poll",
  () =>
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
          cursors: { ENG: "2026-11-15T11:00:00.000Z" },
          delivered: {},
          held: [
            {
              threadId: "thread-mine",
              projectId: "project-web",
              commentId: "comment-old",
              text: "old",
              linkedSender: { environmentId: "linear", threadId: "linear-comment-old", title: "X" },
              since: "2026-11-15T10:00:00.000Z",
              attempts: 0,
            },
          ],
        }),
      );
      const inbox = makeInbox(baseDir, [samComment("comment-1", "2026-11-15T12:00:00.000Z")]);
      inbox.thread.runtimeMode = "full-access";

      yield* inbox.poll;
      expect(inbox.sent.map((input) => input.commandId)).toEqual([
        "linear-inbox:thread-mine:comment-old",
        "linear-inbox:thread-mine:comment-1",
      ]);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.effect("reads comments in full only when the probe finds a new one", () =>
  Effect.gen(function* () {
    const comments: Array<LinearComment> = [];
    const inbox = makeInbox(yield* tempBaseDir, comments);
    yield* inbox.poll;
    // A new team starts now, without reading Linear.
    expect(inbox.queries).toEqual([]);
    yield* inbox.poll;
    expect(inbox.queries).toEqual(["probe"]);
    comments.push(samComment("comment-1", "2099-01-01T00:00:00.000Z"));
    yield* inbox.poll;
    expect(inbox.queries).toEqual(["probe", "probe", "full"]);
    expect(inbox.sent).toHaveLength(1);
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.effect(
  "sends an unaddressed agent comment to the project's Inbox, which forwards it unchanged",
  () =>
    Effect.gen(function* () {
      recordInboxThread(WEB, INBOX);
      const inbox = makeInbox(yield* tempBaseDir, [
        samComment("comment-1", "2026-11-15T12:00:00.000Z", "agent: who owns the cursor?", false),
        samComment("comment-2", "2026-11-15T12:01:00.000Z", "Who owns the cursor?", false),
      ]);
      yield* inbox.poll;
      yield* inbox.poll;

      // The agent's comment reaches the Inbox; the person's waits for a linked thread.
      expect(inbox.sent.map((input) => input.threadId)).toEqual([INBOX]);
      expect(
        linearInboxLog().map((entry) => [
          entry.commentId,
          entry.outcome,
          entry.via ?? entry.reason,
        ]),
      ).toEqual([
        ["comment-1", "delivered", "inbox"],
        ["comment-2", "not-delivered", "no-thread-link"],
      ]);
      expect(linearInboxLog()[1]?.projectIds).toEqual([WEB]);

      const forward = (threadId: string, commentId = "comment-1") =>
        inbox.use((service) =>
          service
            .forward({
              inboxThreadId: INBOX,
              environmentId: EnvironmentId.make("env-me"),
              forward: { threadId: ThreadId.make(threadId), commentId },
            })
            .pipe(
              Effect.flip,
              Effect.map((error) => error.detail),
            ),
        );
      expect(yield* forward("thread-away")).toMatch(/own project/);
      expect(yield* forward("thread-inbox")).toMatch(/itself/);
      expect(yield* forward("thread-other", "comment-2")).toMatch(/teammate's message/);
      // A reply needs the comment to have reached the thread.
      const reply = (threadId: string) =>
        inbox.use((service) =>
          service.reply({
            thread: { id: ThreadId.make(threadId), title: "Cursor" },
            commentId: "comment-1",
            text: "Mine.",
          }),
        );
      expect(yield* reply("thread-other").pipe(Effect.flip)).toMatchObject({
        _tag: "LinearInboxRefusal",
      });

      const result = yield* inbox.use((service) =>
        service.forward({
          inboxThreadId: INBOX,
          environmentId: EnvironmentId.make("env-me"),
          forward: { threadId: ThreadId.make("thread-other"), commentId: "comment-1" },
        }),
      );
      expect(result.messageId).toBe("linear-inbox:thread-other:comment-1");
      const [atInbox, forwarded] = inbox.sent;
      expect(forwarded).toMatchObject({
        threadId: "thread-other",
        projectId: "project-web",
        text: atInbox!.text,
        linkedSender: atInbox!.linkedSender,
        mode: "queue",
        createdBy: "agent",
      });
      yield* reply("thread-other");
      expect(inbox.replies).toEqual([
        {
          thread: { id: "thread-other", title: "Cursor" },
          issueId: "issue-2",
          issue: "ENG-2",
          parentId: "comment-1",
          text: "Mine.",
        },
      ]);
      // Another thread of the project still may not answer it.
      expect(yield* reply("thread-mine").pipe(Effect.flip)).toMatchObject({
        _tag: "LinearInboxRefusal",
      });
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
        cursors: { ENG: "1970-01-01T00:00:00.000Z" },
        delivered: { "thread-mine": Array.from({ length: 11 }, () => "1970-01-01T00:00:00.000Z") },
        held: [],
      }),
    );
    const inbox = makeInbox(baseDir, [
      samComment("comment-1", "2026-11-15T12:00:00.000Z", "Can you take the cursor file?"),
      samComment("comment-2", "2026-11-15T12:01:00.000Z", "And the dedupe?"),
    ]);

    yield* inbox.poll;
    expect(inbox.sent.map((input) => input.commandId)).toEqual([
      "linear-inbox:thread-mine:comment-1",
    ]);
    expect(inbox.sent[0]!.linkedSender?.title).toBe("Sam Lee");
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.effect("failed deliveries stop counting toward the daily limit a day after they arrived", () =>
  Effect.gen(function* () {
    const baseDir = yield* tempBaseDir;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfig.ServerConfig.pipe(
      Effect.provide(ServerConfig.layerTest(process.cwd(), baseDir)),
    );
    const statePath = path.join(config.stateDir, "linear-inbox.json");
    const held = (id: number) => ({
      threadId: "thread-mine",
      projectId: "project-web",
      commentId: `old-${id}`,
      text: "old",
      linkedSender: { environmentId: "linear", threadId: `linear-comment-old-${id}`, title: "X" },
      since: "1969-12-30T00:00:00.000Z",
      attempts: 0,
    });
    yield* fileSystem.writeFileString(
      statePath,
      JSON.stringify({
        cursors: { ENG: "1970-01-01T00:00:00.000Z" },
        delivered: {},
        held: Array.from({ length: 12 }, (_, id) => held(id)),
      }),
    );
    const inbox = makeInbox(baseDir, [samComment("comment-1", "2026-11-15T12:00:00.000Z")]);
    // Every send fails, so the old comments stay held while the new one arrives.
    inbox.failures.sends = 13;

    yield* inbox.poll;
    const state = JSON.parse(yield* fileSystem.readFileString(statePath));
    expect(state.held.map((item: { commentId: string }) => item.commentId).at(-1)).toBe(
      "comment-1",
    );
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.effect(
  "reads a comment again after its thread could not be read, and retries a failed delivery",
  () =>
    Effect.gen(function* () {
      const inbox = makeInbox(yield* tempBaseDir, [
        samComment("comment-1", "2026-11-15T12:00:00.000Z"),
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
