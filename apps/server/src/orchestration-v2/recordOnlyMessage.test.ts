import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import { isActiveRun } from "./CommandPolicy.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const instanceId = ProviderInstanceId.make("codex");
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process: the effect worker does not run"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "record-only-message" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

const send = (
  threadId: ThreadId,
  id: string,
  text: string,
  dispatchMode: { readonly type: "start_immediately" } | { readonly type: "record_only" },
) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    return yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`send:${threadId}:${id}`),
      threadId,
      messageId: MessageId.make(`message:${threadId}:${id}`),
      text,
      attachments: [],
      dispatchMode,
      createdBy: "user",
      creationSource: "web",
    });
  });

const createThread = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${threadId}`),
      threadId,
      projectId: ProjectId.make("project:record-only"),
      title: "Dismissals",
      modelSelection: { instanceId, model: "gpt-5" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
  });

it.layer(layerTest)("record-only messages", (it) => {
  it.effect("record a dismissal during a run without a run, steer or queue", () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const threadId = ThreadId.make("thread:record-only:dismiss");
      yield* createThread(threadId);
      yield* send(threadId, "go", "Ship it", { type: "start_immediately" });
      const before = yield* store.getThreadProjection(threadId);
      assert.strictEqual(before.runs.length, 1);
      assert.isTrue(before.runs.every(isActiveRun));

      yield* TestClock.adjust("1 minute");
      yield* send(threadId, "dismiss", "Q1: dismissed\nQ2: dismissed", { type: "record_only" });
      const after = yield* store.getThreadProjection(threadId);
      assert.deepEqual(after.runs, before.runs);
      const dismissal = after.messages.find((message) => message.text.startsWith("Q1:"));
      assert.strictEqual(dismissal?.role, "user");
      assert.strictEqual(dismissal?.runId, null);
      const item = after.turnItems.find(
        (candidate) => candidate.type === "user_message" && candidate.messageId === dismissal?.id,
      );
      assert.strictEqual(item?.runId, null);
      assert.strictEqual(item?.status, "completed");
      // The dismissal is not the user writing to the agent.
      const prompt = after.messages.find((message) => message.text === "Ship it");
      const stored = (yield* store.getShellSnapshot()).threads.find(
        (thread) => thread.id === threadId,
      );
      for (const shell of [stored, ProjectionStore.threadShellFromProjection(after)]) {
        assert.deepEqual(shell?.latestUserMessageAt, prompt?.updatedAt);
        assert.deepEqual(shell?.latestUserAuthoredMessageAt, prompt?.updatedAt);
      }
    }),
  );

  it.effect("refuses anything but dismissal lines, and records nothing", () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const threadId = ThreadId.make("thread:record-only:refused");
      yield* createThread(threadId);
      for (const [index, text] of [
        "Please stop",
        "Q1: dismissed\nAlso stop",
        "Q1: skipped",
      ].entries()) {
        const exit = yield* Effect.exit(
          send(threadId, `refused-${index}`, text, { type: "record_only" }),
        );
        assert.strictEqual(exit._tag, "Failure");
      }
      const projection = yield* store.getThreadProjection(threadId);
      assert.deepEqual(projection.messages, []);
      assert.deepEqual(projection.runs, []);
    }),
  );
});
