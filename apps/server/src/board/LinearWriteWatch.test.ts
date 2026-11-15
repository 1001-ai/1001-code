import {
  EventId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as Board from "./Board.ts";
import { watch } from "./LinearWriteWatch.ts";

const threadId = ThreadId.make("thread-1");
const at = DateTime.makeUnsafe("2026-11-15T10:00:00.000Z");

const toolEvent = (
  id: string,
  toolName: string,
  status: OrchestrationV2TurnItem["status"],
): OrchestrationV2DomainEvent => ({
  type: "turn-item.updated",
  id: EventId.make(`event-${id}-${status}`),
  threadId,
  runId: RunId.make("run-1"),
  occurredAt: at,
  payload: {
    id: TurnItemId.make(id),
    threadId,
    runId: RunId.make("run-1"),
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    status,
    title: null,
    startedAt: at,
    completedAt: status === "completed" ? at : null,
    updatedAt: at,
    type: "dynamic_tool",
    toolName,
    input: {},
  },
});

/** How many times the watcher asked open boards to refresh while it read `events`. */
const refreshesFor = (events: ReadonlyArray<OrchestrationV2DomainEvent>) =>
  Effect.gen(function* () {
    let refreshes = 0;
    const ended = yield* Deferred.make<void>();
    yield* watch.pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(Board.Board)({ refreshOpen: Effect.sync(() => void (refreshes += 1)) }),
          Layer.mock(Orchestrator.OrchestratorV2)({
            streamDomainEvents: Stream.fromIterable(events).pipe(
              Stream.ensuring(Deferred.succeed(ended, undefined)),
            ),
          }),
        ),
      ),
    );
    yield* Deferred.await(ended);
    return refreshes;
  }).pipe(Effect.scoped);

describe("watch", () => {
  it.effect("refreshes open boards once per finished Linear write", () =>
    Effect.gen(function* () {
      const save = "mcp__claude_ai_Linear__save_issue";
      expect(
        yield* refreshesFor([
          toolEvent("write-1", save, "running"),
          toolEvent("read-1", "mcp__claude_ai_Linear__list_issues", "completed"),
          toolEvent("other-1", "mcp__github__create_issue", "completed"),
          toolEvent("failed-1", save, "failed"),
          toolEvent("write-1", save, "completed"),
          toolEvent("write-1", save, "completed"),
          toolEvent("write-2", "linear.save_issue", "completed"),
        ]),
      ).toBe(2);
    }),
  );
});
