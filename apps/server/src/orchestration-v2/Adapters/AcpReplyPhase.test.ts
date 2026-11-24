import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import type * as EffectAcpSchema from "effect-acp/compat";
import * as EffectAcpErrors from "effect-acp/errors";

import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import type * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import {
  AcpProviderCapabilitiesV2,
  makeAcpAdapterV2,
  type AcpAdapterV2Flavor,
} from "@t3tools/provider-acp/server/adapter";

type RuntimeService = AcpSessionRuntime.AcpSessionRuntime["Service"];

const layerSession = Layer.mergeAll(
  NodeServices.layer,
  NodeCrypto.layer,
  IdAllocator.layer,
  McpProviderSessions.layer,
  TestProviderHost.layer().pipe(
    Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  ),
);

const setupHarness = Effect.fn("setupAcpReplyPhaseHarness")(function* (options: {
  readonly replyEndsWithUsageUpdate?: boolean;
  readonly deferFinalizeForBackgroundWork?: boolean;
  readonly steersWithPrompt?: boolean;
  readonly onPrompt: (input: {
    readonly index: number;
    readonly send: (
      update: EffectAcpSchema.SessionUpdate,
    ) => Effect.Effect<void, EffectAcpErrors.AcpError>;
  }) => Effect.Effect<EffectAcpSchema.PromptResponse, EffectAcpErrors.AcpError>;
}) {
  const sessionId = "acp-reply-phase-session";
  let sessionUpdateHandler:
    | ((
        notification: EffectAcpSchema.SessionNotification,
      ) => Effect.Effect<void, EffectAcpErrors.AcpError>)
    | undefined;
  let promptCount = 0;

  const send = (
    update: EffectAcpSchema.SessionUpdate,
  ): Effect.Effect<void, EffectAcpErrors.AcpError> =>
    Effect.suspend(() =>
      sessionUpdateHandler === undefined
        ? Effect.die("sessionUpdate handler not registered")
        : sessionUpdateHandler({ sessionId, update }),
    );

  const unsupported = (name: string) =>
    Effect.fail(
      new EffectAcpErrors.AcpTransportError({
        detail: `${name} unsupported in test`,
        cause: `${name} unsupported`,
      }),
    );

  const initResult: EffectAcpSchema.InitializeResponse = {
    protocolVersion: 1,
    agentInfo: { name: "mock-acp", version: "1.0.0" },
    agentCapabilities: { loadSession: false },
  };

  const startResult: AcpSessionRuntime.AcpSessionRuntimeStartResult = {
    sessionId,
    initializeResult: initResult,
    sessionSetupResult: { sessionId, configOptions: [] },
    modelConfigId: undefined,
  };

  const makeRuntime = (): Effect.Effect<RuntimeService> =>
    Effect.succeed({
      handleRequestPermission: () => Effect.void,
      handleElicitation: () => Effect.void,
      handleMcpConnect: () => Effect.void,
      handleMcpMessage: () => Effect.void,
      handleMcpDisconnect: () => Effect.void,
      handleMcpNotification: () => Effect.void,
      handleReadTextFile: () => Effect.void,
      handleWriteTextFile: () => Effect.void,
      handleCreateTerminal: () => Effect.void,
      handleTerminalOutput: () => Effect.void,
      handleTerminalWaitForExit: () => Effect.void,
      handleTerminalKill: () => Effect.void,
      handleTerminalRelease: () => Effect.void,
      handleSessionUpdate: (handler) =>
        Effect.sync(() => {
          sessionUpdateHandler = handler;
        }),
      handleElicitationComplete: () => Effect.void,
      handleUnknownExtRequest: () => Effect.void,
      handleUnknownExtNotification: () => Effect.void,
      handleExtRequest: () => Effect.void,
      handleExtNotification: () => Effect.void,
      initialize: () => Effect.succeed(initResult),
      start: () => Effect.succeed(startResult),
      getEvents: () => Stream.empty,
      drainEvents: Effect.void,
      getModeState: Effect.undefined,
      getConfigOptions: Effect.succeed([]),
      configOptionChanges: Stream.empty,
      loadSession: () => Effect.succeed(startResult),
      resumeSession: () => Effect.succeed(startResult),
      forkSession: () => Effect.succeed(startResult),
      listSessions: () => unsupported("listSessions"),
      closeSession: () => Effect.succeed({}),
      deleteSession: () => unsupported("deleteSession"),
      listProviders: unsupported("listProviders"),
      setProvider: () => unsupported("setProvider"),
      disableProvider: () => unsupported("disableProvider"),
      logout: unsupported("logout"),
      prompt: (_payload, promptOptions) =>
        Effect.gen(function* () {
          const index = ++promptCount;
          if (promptOptions?.dispatched !== undefined) {
            yield* Deferred.succeed(promptOptions.dispatched, undefined);
          }
          return yield* options.onPrompt({ index, send });
        }),
      cancel: Effect.void,
      setMode: () => Effect.succeed({}),
      setSessionModel: () => Effect.succeed({}),
      setConfigOption: () => Effect.succeed({ configOptions: [] }),
      setModel: () => Effect.void,
      request: () => unsupported("request"),
      notify: () => Effect.void,
    });

  const driver = ProviderDriverKind.make("antigravity");
  const instanceId = ProviderInstanceId.make("acp-reply-phase-test");
  const threadId = ThreadId.make("thread-acp-reply-phase");
  const selfInvocation = yield* resolveSelfInvocation();

  const flavor: AcpAdapterV2Flavor = {
    driver,
    capabilities: AcpProviderCapabilitiesV2,
    makeRuntime,
    ...(options.replyEndsWithUsageUpdate ? { replyEndsWithUsageUpdate: true } : {}),
    ...(options.deferFinalizeForBackgroundWork
      ? {
          deferFinalizeForBackgroundWork: true,
          toolOutlivesPrompt: (toolCall) => toolCall.toolCallId.startsWith("bg_"),
        }
      : {}),
    ...(options.steersWithPrompt ? { steersWithPrompt: () => true } : {}),
  };

  const adapter = yield* makeAcpAdapterV2({
    instanceId,
    flavor,
    selfInvocation,
  });

  const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
    runtimeMode: "full-access",
    interactionMode: "default",
    cwd: process.cwd(),
  });
  const modelSelection = { instanceId, model: "test-model" } as const;
  const session = yield* adapter.openSession({
    threadId,
    providerSessionId: ProviderSessionId.make("provider-session-acp-reply-phase"),
    modelSelection,
    runtimePolicy,
  });
  const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
  yield* session.events.pipe(
    Stream.runForEach((event) => Queue.offer(events, event)),
    Effect.forkScoped,
  );
  const providerThread = yield* session.ensureThread({
    threadId,
    modelSelection,
    runtimePolicy,
  });

  const now = yield* DateTime.now;
  const runId = RunId.make("run-acp-reply-phase-1");
  const startTurn = () =>
    session.startTurn({
      appThread: {
        createdBy: "user",
        creationSource: "web",
        id: threadId,
        projectId: ProjectId.make("project-acp-reply-phase"),
        title: "ACP reply phase",
        providerInstanceId: instanceId,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: process.cwd(),
        activeProviderThreadId: providerThread.id,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      },
      threadId,
      runId,
      runOrdinal: 1,
      providerTurnOrdinal: 1,
      attemptId: RunAttemptId.make("attempt-acp-reply-phase-1"),
      rootNodeId: NodeId.make("node-acp-reply-phase-1"),
      providerThread,
      message: {
        createdBy: "user",
        creationSource: "web",
        messageId: MessageId.make("msg-1"),
        text: "Run and report",
        attachments: [],
      },
      modelSelection,
      runtimePolicy,
    });

  const collectUntilTerminal = Effect.gen(function* () {
    const seen: Array<ProviderAdapter.ProviderAdapterV2Event> = [];
    while (true) {
      const event = yield* Queue.take(events);
      seen.push(event);
      if (event.type === "turn.terminal") return seen;
    }
  });

  return {
    session,
    providerThread,
    threadId,
    runId,
    send,
    startTurn,
    events,
    collectUntilTerminal,
  };
});

function finalAssistantItemsByText(
  events: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>,
): Map<string, Extract<OrchestrationV2TurnItem, { readonly type: "assistant_message" }>> {
  const byText = new Map<
    string,
    Extract<OrchestrationV2TurnItem, { readonly type: "assistant_message" }>
  >();
  for (const event of events) {
    if (event.type !== "turn_item.updated" || event.turnItem.type !== "assistant_message") continue;
    if (event.turnItem.status === "completed") {
      byText.set(event.turnItem.text, event.turnItem);
    }
  }
  return byText;
}

describe("ACP adapter assistant_message final_answer phase", () => {
  it.effect(
    "tags completed usage_update replies as final_answer across background wakes while leaving tool narration untagged",
    () =>
      Effect.gen(function* () {
        const prompt1Done = yield* Deferred.make<void>();
        const usage: EffectAcpSchema.SessionUpdate = {
          sessionUpdate: "usage_update",
          used: 9000,
          size: 1_000_000,
        };
        const { send, startTurn, collectUntilTerminal } = yield* setupHarness({
          replyEndsWithUsageUpdate: true,
          deferFinalizeForBackgroundWork: true,
          onPrompt: ({ send: emit }) =>
            Effect.gen(function* () {
              yield* emit({
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: "Checking CI status..." },
              });
              yield* emit({
                sessionUpdate: "tool_call",
                toolCallId: "bg_cmd_1",
                kind: "execute",
                title: "watch deploy",
                status: "in_progress",
              });
              yield* emit({
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: "CI passed; watching deploy." },
              });
              yield* emit(usage);
              yield* Deferred.succeed(prompt1Done, undefined);
              return { stopReason: "end_turn" as const };
            }),
        });

        yield* startTurn();
        yield* Deferred.await(prompt1Done);
        yield* TestClock.adjust("100 millis");
        // Background command completes, waking the agent for a second reply in the same run.
        yield* send({
          sessionUpdate: "tool_call_update",
          toolCallId: "bg_cmd_1",
          status: "completed",
          rawOutput: { output: "deployed", exit_code: 0 },
        });
        yield* send({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Deploy is green." },
        });
        yield* send(usage);
        yield* TestClock.adjust("5 seconds");

        const seen = yield* collectUntilTerminal;
        const replies = finalAssistantItemsByText(seen);

        assert.isUndefined(replies.get("Checking CI status...")?.phase);
        assert.equal(replies.get("CI passed; watching deploy.")?.phase, "final_answer");
        assert.equal(replies.get("Deploy is green.")?.phase, "final_answer");
      }).pipe(Effect.provide(layerSession)),
  );

  it.effect(
    "tags a completed prompt reply as final_answer when prompt-steering supersedes the first prompt without usage_update",
    () =>
      Effect.gen(function* () {
        const prompt1Streamed = yield* Deferred.make<void>();
        const releasePrompt1 = yield* Deferred.make<void>();
        const releasePrompt2 = yield* Deferred.make<void>();

        const {
          session,
          providerThread,
          threadId,
          runId,
          events,
          startTurn,
          collectUntilTerminal,
        } = yield* setupHarness({
          steersWithPrompt: true,
          onPrompt: ({ index, send: emit }) =>
            Effect.gen(function* () {
              if (index === 1) {
                yield* emit({
                  sessionUpdate: "agent_message_chunk",
                  content: { type: "text", text: "First complete answer." },
                });
                yield* Deferred.succeed(prompt1Streamed, undefined);
                yield* Deferred.await(releasePrompt1);
                return { stopReason: "end_turn" as const };
              }
              yield* Deferred.await(releasePrompt2);
              yield* emit({
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: "Follow-up answer to steer." },
              });
              return { stopReason: "end_turn" as const };
            }),
        });

        yield* startTurn();
        yield* Deferred.await(prompt1Streamed);

        // Drain initial events to get the active providerTurnId.
        const seen: Array<ProviderAdapter.ProviderAdapterV2Event> = [];
        let providerTurnId:
          | ProviderAdapter.ProviderAdapterV2SteerInput["providerTurnId"]
          | undefined;
        while (providerTurnId === undefined) {
          const event = yield* Queue.take(events);
          seen.push(event);
          if (event.type === "provider_turn.updated") {
            providerTurnId = event.providerTurn.id;
          }
        }

        // Steer arrives while prompt 1 is finishing its reply.
        yield* session.steerTurn!({
          threadId,
          runId,
          providerThread,
          providerTurnId,
          message: {
            createdBy: "user",
            creationSource: "web",
            messageId: MessageId.make("steer-1"),
            text: "Also check staging",
            attachments: [],
          },
        });
        yield* Deferred.succeed(releasePrompt1, undefined);

        // Wait until prompt 1's settled reply is emitted as completed before prompt 2 responds.
        while (true) {
          const event = yield* Queue.take(events);
          seen.push(event);
          if (
            event.type === "turn_item.updated" &&
            event.turnItem.type === "assistant_message" &&
            event.turnItem.text === "First complete answer." &&
            event.turnItem.status === "completed"
          ) {
            break;
          }
        }
        yield* Deferred.succeed(releasePrompt2, undefined);

        seen.push(...(yield* collectUntilTerminal));
        const replies = finalAssistantItemsByText(seen);

        assert.equal(replies.get("First complete answer.")?.phase, "final_answer");
        assert.isDefined(replies.get("Follow-up answer to steer."));
      }).pipe(Effect.provide(layerSession)),
  );

  it.effect(
    "tags a settled prompt reply as final_answer when background work keeps the run open without usage_update",
    () =>
      Effect.gen(function* () {
        const promptSettled = yield* Deferred.make<void>();
        const { send, startTurn, collectUntilTerminal } = yield* setupHarness({
          deferFinalizeForBackgroundWork: true,
          onPrompt: ({ send: emit }) =>
            Effect.gen(function* () {
              yield* emit({
                sessionUpdate: "tool_call",
                toolCallId: "bg_cmd_2",
                kind: "execute",
                title: "build image",
                status: "in_progress",
              });
              yield* emit({
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: "Started background image build." },
              });
              yield* Deferred.succeed(promptSettled, undefined);
              return { stopReason: "end_turn" as const };
            }),
        });

        yield* startTurn();
        yield* Deferred.await(promptSettled);
        // Let prompt settlement complete before finishing the background command.
        yield* TestClock.adjust("100 millis");
        yield* send({
          sessionUpdate: "tool_call_update",
          toolCallId: "bg_cmd_2",
          status: "completed",
          rawOutput: { output: "built", exit_code: 0 },
        });
        yield* send({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Image build finished." },
        });
        yield* TestClock.adjust("5 seconds");

        const seen = yield* collectUntilTerminal;
        const replies = finalAssistantItemsByText(seen);

        assert.equal(replies.get("Started background image build.")?.phase, "final_answer");
        assert.isDefined(replies.get("Image build finished."));
      }).pipe(Effect.provide(layerSession)),
  );
});
