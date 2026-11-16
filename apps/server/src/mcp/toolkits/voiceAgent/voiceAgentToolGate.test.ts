import { NodeHttpServer } from "@effect/platform-node";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpBody, HttpClient, HttpRouter } from "effect/http";

import * as Orchestrator from "../../../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../../../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as PullRequestReviewGuideService from "../../../pullRequest/PullRequestReviewGuideService.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as VoiceAgent from "../../../voiceAgent/VoiceAgent.ts";
import { voiceAgentThread } from "../../../voiceAgent/voiceAgentThread.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import type * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpSessionRegistry from "../../McpSessionRegistry.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as VoiceAgentHandlers from "./handlers.ts";
import { VoiceAgentToolkit } from "./tools.ts";

const environmentId = EnvironmentId.make("environment-test");
const CHAT = ThreadId.make("thread-chat");
const VOICE = ThreadId.make("thread-voice");

it.effect(
  "lists and runs only the voice agent's tools for its thread, and hides them from every other",
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
        ]);
        const boardCalls: Array<string> = [];
        const serverLayer = McpHttpServer.layerMcpTransport(
          Layer.mergeAll(
            McpHttpServer.layerPullRequestsToolkit,
            McpHttpServer.toolkitRegistration(VoiceAgentToolkit, VoiceAgentHandlers.layer),
            McpHttpServer.layerVoiceAgentToolGate,
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
                        readonly error?: unknown;
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
              ran: (name: string) =>
                rpc("tools/call", { name, arguments: {} }).pipe(
                  Effect.map((body) => body.error === undefined && body.result?.isError !== true),
                ),
            };
          });

        const voice = yield* session(VOICE);
        expect(yield* voice.listed).toEqual([
          "voice_board",
          "voice_send_message",
          "voice_show_media",
        ]);
        expect(yield* voice.ran("voice_board")).toBe(true);
        expect(boardCalls).toEqual([VOICE]);
        // Every other tool of the server is gone for it, on the call as on the list.
        expect(yield* voice.ran("link_pull_request")).toBe(false);
        expect(yield* voice.ran("read_pull_request_guide")).toBe(false);

        const ordinary = yield* session(CHAT);
        const ordinaryTools = yield* ordinary.listed;
        expect(ordinaryTools).toContain("link_pull_request");
        expect(ordinaryTools.filter((tool) => tool.startsWith("voice_"))).toEqual([]);
        expect(yield* ordinary.ran("voice_board")).toBe(false);
        expect(boardCalls).toEqual([VOICE]);

        // A thread that cannot be read is given nothing, rather than everything.
        const unknown = yield* session(ThreadId.make("thread-gone"));
        expect(yield* unknown.listed).toEqual([]);
        expect(yield* unknown.ran("voice_board")).toBe(false);
      }),
    ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);
