import { NodeHttpServer } from "@effect/platform-node";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  MessageId,
  OrchestratorMcpFailure,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import { HttpBody, HttpClient, HttpRouter } from "effect/http";

import { INBOX_FORWARD_NOT_TEAMMATE } from "../inboxAgent/inboxAgentForward.ts";
import {
  INBOX_LAUNCH_NEEDS_WORKTREE,
  INBOX_SEND_OTHER_PROJECT,
} from "../inboxAgent/inboxAgentSend.ts";
import { recordInboxThread } from "../inboxAgent/inboxAgentThreads.ts";
import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import * as McpToolAccess from "../mcp/McpToolAccess.ts";
import { liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import * as VoiceAgentHandlers from "../mcp/toolkits/voiceAgent/handlers.ts";
import { VoiceAgentToolkit } from "../mcp/toolkits/voiceAgent/tools.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as PullRequestReviewGuideService from "../pullRequest/PullRequestReviewGuideService.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as VoiceAgent from "../voiceAgent/VoiceAgent.ts";
import { voiceAgentThread } from "../voiceAgent/voiceAgentThread.ts";

const environmentId = EnvironmentId.make("environment-test");
const CHAT = ThreadId.make("thread-chat");
const VOICE = ThreadId.make("thread-voice");
const INBOX = ThreadId.make("thread-inbox");
const ELSEWHERE = ThreadId.make("thread-elsewhere");

/**
 * Stand-ins under the real names of the tools the Inbox may use, and one it may not: the gate
 * reads only the name, so these show what it lets through without each toolkit's services.
 */
const NAMED_TOOLS = [
  "t3_thread_list",
  "t3_thread_read",
  "t3_thread_search",
  "board_list",
  "memory_propose",
  "memory_withdraw",
  "t3_thread_send",
  "t3_thread_wait",
  "t3_thread_launch",
  "orchestrator_capabilities",
  "t3_thread_interrupt",
  "inbox_forward",
] as const;
const probe = (name: string) =>
  Tool.make(name, {
    description: "A stand-in.",
    parameters: Schema.Struct({
      threadId: Schema.optional(Schema.String),
      message: Schema.optional(Schema.String),
      commentId: Schema.optional(Schema.String),
      workspaceStrategy: Schema.optional(Schema.Unknown),
    }),
    success: Schema.Struct({ ok: Schema.Boolean }),
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies: [McpInvocationContext.McpInvocationContext],
  });
const NamedToolkit = Toolkit.make(...NAMED_TOOLS.map(probe));
const namedHandlers = McpToolAccess.toLayer(
  NamedToolkit,
  Object.fromEntries(
    NAMED_TOOLS.map((name) => [name, McpToolAccess.reads(() => Effect.succeed({ ok: true }))]),
  ) as never,
);

it.effect(
  "lists and runs only a locked agent's own tools for its thread, and hides the voice tools from every other",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const scopeFor = (threadId: ThreadId): McpInvocationContext.McpThreadInvocationScope => ({
          environmentId,
          requestNamespace: threadId,
          thread: {
            threadId,
            providerSessionId: threadId,
            providerInstanceId: ProviderInstanceId.make("claudeAgent"),
          },
          client: undefined,
          capabilities: new Set(["orchestration", "pull-requests"]),
          issuedAt: 1,
        });
        const chat = liveThreadShell(CHAT);
        const shells = new Map([
          [CHAT, chat],
          [
            VOICE,
            {
              ...liveThreadShell(VOICE),
              ...voiceAgentThread(chat as never, CHAT, chat),
              id: VOICE,
            },
          ],
          // An ordinary thread: only the server's record makes it the Inbox.
          [INBOX, liveThreadShell(INBOX)],
          [
            ELSEWHERE,
            { ...liveThreadShell(ELSEWHERE), projectId: ProjectId.make("project-other") },
          ],
        ]);
        const userMessageId = MessageId.make("message-user");
        recordInboxThread(ProjectId.make("project-acme"), INBOX);
        const boardCalls: Array<string> = [];
        const serverLayer = McpHttpServer.layerMcpTransport(
          Layer.mergeAll(
            McpHttpServer.layerPullRequestsToolkit,
            McpHttpServer.toolkitRegistration(VoiceAgentToolkit, VoiceAgentHandlers.layer),
            McpHttpServer.toolkitRegistration(NamedToolkit, namedHandlers),
            McpHttpServer.layerLockedAgentToolGate,
          ),
        ).pipe(
          Layer.provide(ServerSettings.layerTest()),
          Layer.provide(
            Layer.mock(McpSessionRegistry.McpSessionRegistry)({
              resolve: (token) =>
                Effect.succeed(token === "" ? undefined : scopeFor(ThreadId.make(token))),
            }),
          ),
          Layer.provide(
            Layer.mergeAll(
              Layer.mock(ThreadManagementService.ThreadManagementService)({
                getThreadShell: (threadId) =>
                  Effect.succeed((shells.get(threadId) as typeof chat | undefined) ?? null),
                // The Inbox's run answers the user's own message.
                getThreadRecords: () =>
                  Effect.succeed({
                    runs: [{ id: RunId.make("run:mcp-test"), userMessageId }],
                    messages: [
                      { id: userMessageId, role: "user", createdBy: "user", creationSource: "web" },
                    ],
                  } as never),
              }),
              Layer.mock(VoiceAgent.VoiceAgent)({
                board: (caller) =>
                  Effect.sync(() => {
                    boardCalls.push(caller.threadId);
                    return { agentsRunning: 2 } as never;
                  }),
              }),
              Layer.mock(ProjectService.ProjectService)({}),
              Layer.mock(PullRequestReviewGuideService.PullRequestReviewGuideService)({}),
              Layer.mock(PullRequestService.PullRequestService)({}),
              Layer.mock(Orchestrator.OrchestratorV2)({}),
              Layer.mock(ProjectionStore.ProjectionStoreV2)({}),
              NodeServices.layer,
              NodeCrypto.layer,
            ),
          ),
        );
        yield* HttpRouter.serve(serverLayer, { disableListenLog: true, disableLogger: true }).pipe(
          Layer.build,
        );
        const httpClient = yield* HttpClient.HttpClient;
        const session = (threadId: ThreadId) =>
          Effect.gen(function* () {
            const headers = {
              accept: "application/json, text/event-stream",
              authorization: `Bearer ${threadId}`,
            };
            const initialize = yield* httpClient.post("/mcp", {
              headers,
              body: HttpBody.text(
                `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"1.0.0"}}}`,
                "application/json",
              ),
            });
            const rpc = (method: string, params: object) =>
              httpClient
                .post("/mcp", {
                  headers: {
                    ...headers,
                    "mcp-session-id": initialize.headers["mcp-session-id"]!,
                    "mcp-protocol-version": "2025-06-18",
                  },
                  body: HttpBody.text(
                    JSON.stringify({ jsonrpc: "2.0", id: 2, method, params }),
                    "application/json",
                  ),
                })
                .pipe(
                  Effect.flatMap((response) => response.json),
                  Effect.map(
                    (body) =>
                      body as {
                        readonly error?: { readonly message?: string };
                        readonly result?: {
                          readonly tools?: ReadonlyArray<{ readonly name: string }>;
                          readonly isError?: boolean;
                          readonly structuredContent?: unknown;
                        };
                      },
                  ),
                );
            return {
              listed: rpc("tools/list", {}).pipe(
                Effect.map((body) =>
                  (body.result?.tools ?? []).map((tool) => tool.name).toSorted(),
                ),
              ),
              /** Whether the call ran: a tool the caller cannot see fails like one that is not there. */
              ran: (name: string, args: object = {}) =>
                rpc("tools/call", { name, arguments: args }).pipe(
                  Effect.map((body) => body.error === undefined && body.result?.isError !== true),
                ),
              refusal: (name: string, args: object) =>
                rpc("tools/call", { name, arguments: args }).pipe(
                  Effect.map((body) => body.error?.message),
                ),
            };
          });

        const voice = yield* session(VOICE);
        expect(yield* voice.listed).toEqual([
          "memory_propose",
          "memory_withdraw",
          "voice_board",
          "voice_send_message",
          "voice_show_media",
        ]);
        expect(yield* voice.ran("voice_board")).toBe(true);
        expect(boardCalls).toEqual([VOICE]);
        // Every other tool of the server is gone for it, on the call as on the list.
        expect(yield* voice.ran("link_pull_request")).toBe(false);
        expect(yield* voice.ran("read_pull_request_guide")).toBe(false);
        expect(yield* voice.ran("t3_thread_read")).toBe(false);

        // The Inbox reads threads and the Board, and messages and starts its own project's threads.
        const inbox = yield* session(INBOX);
        expect(yield* inbox.listed).toEqual([
          "board_list",
          "inbox_forward",
          "memory_propose",
          "memory_withdraw",
          "orchestrator_capabilities",
          "t3_thread_launch",
          "t3_thread_list",
          "t3_thread_read",
          "t3_thread_search",
          "t3_thread_send",
          "t3_thread_wait",
        ]);
        expect(yield* inbox.ran("t3_thread_read")).toBe(true);
        expect(yield* inbox.ran("t3_thread_send", { threadId: CHAT, message: "Status?" })).toBe(
          true,
        );
        expect(yield* inbox.refusal("t3_thread_send", { threadId: ELSEWHERE, message: "Hi" })).toBe(
          INBOX_SEND_OTHER_PROJECT,
        );
        expect(yield* inbox.ran("t3_thread_send")).toBe(false);
        // A forward needs a teammate's message that reached this Inbox.
        expect(
          yield* inbox.refusal("inbox_forward", { threadId: CHAT, commentId: "comment-1" }),
        ).toBe(INBOX_FORWARD_NOT_TEAMMATE);
        const worktree = { type: "worktree", baseRef: "origin/main", startFromOrigin: true };
        expect(yield* inbox.ran("t3_thread_launch", { workspaceStrategy: worktree })).toBe(true);
        expect(yield* inbox.refusal("t3_thread_launch", { message: "Fix it" })).toBe(
          INBOX_LAUNCH_NEEDS_WORKTREE,
        );
        expect(yield* inbox.ran("orchestrator_capabilities")).toBe(true);
        expect(yield* inbox.ran("t3_thread_interrupt", { threadId: CHAT })).toBe(false);
        expect(yield* inbox.ran("link_pull_request")).toBe(false);
        expect(yield* inbox.ran("voice_board")).toBe(false);
        expect(boardCalls).toEqual([VOICE]);

        const ordinary = yield* session(CHAT);
        const ordinaryTools = yield* ordinary.listed;
        expect(ordinaryTools).toContain("link_pull_request");
        expect(ordinaryTools.filter((tool) => tool.startsWith("voice_"))).toEqual([]);
        expect(ordinaryTools).toContain("t3_thread_send");
        expect(ordinaryTools).not.toContain("inbox_forward");
        expect(yield* ordinary.ran("voice_board")).toBe(false);
        expect(boardCalls).toEqual([VOICE]);

        // A thread that cannot be read is given nothing, rather than everything.
        const unknown = yield* session(ThreadId.make("thread-gone"));
        expect(yield* unknown.listed).toEqual([]);
        expect(yield* unknown.ran("voice_board")).toBe(false);
      }),
    ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);
