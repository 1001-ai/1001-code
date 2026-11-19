import { assert, describe, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  type ModelSelection,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  ProjectId,
  type ProjectMomentsStreamItem,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { recordInboxThread } from "../inboxAgent/inboxAgentThreads.ts";
import {
  type InboxStableMove,
  emptyInboxWakeState,
  publishInboxWakeState,
} from "../inboxAgent/inboxAgentWake.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectMoments from "./ProjectMoments.ts";

const database = SqlitePersistence.layerMemory;
const stores = Layer.mergeAll(
  database,
  EventStore.layer.pipe(Layer.provideMerge(database)),
  ProjectionStore.layer.pipe(Layer.provideMerge(database)),
);
const sink = EventSink.layer.pipe(Layer.provide(stores));
// The service reads only the orchestrator's stored event stream, which the sink serves.
const orchestrator = Layer.unwrap(
  Effect.map(EventSink.EventSinkV2, (eventSink) =>
    Layer.mock(Orchestrator.OrchestratorV2)({
      streamStoredEventsFrom: (input) =>
        eventSink.stream({ ...input, bounded: true }).pipe(Stream.orDie),
    }),
  ),
).pipe(Layer.provide(sink));
const layerTest = Layer.mergeAll(
  sink,
  ProjectMoments.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        database,
        orchestrator,
        OrchestrationEventStore.layer.pipe(Layer.provide(database)),
      ),
    ),
  ),
);

const NOW = Date.UTC(2026, 10, 18, 12);
const hoursAgo = (hours: number) => DateTime.makeUnsafe(NOW - hours * 60 * 60 * 1000);
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} satisfies ModelSelection;

let eventCount = 0;
const event = <E extends Omit<OrchestrationV2DomainEvent, "id">>(input: E) =>
  ({
    ...input,
    id: EventId.make(`event:moments:${(eventCount += 1)}`),
  }) as OrchestrationV2DomainEvent;

const thread = (
  key: string,
  projectId: ProjectId,
  overrides: Partial<OrchestrationV2AppThread> = {},
): OrchestrationV2AppThread => {
  const id = ThreadId.make(`thread:moments:${key}`);
  return {
    id,
    projectId,
    title: `Thread ${key}`,
    providerInstanceId: modelSelection.instanceId,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    createdAt: hoursAgo(24 * 10),
    updatedAt: hoursAgo(24 * 10),
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
    ...overrides,
  };
};
const created = (payload: OrchestrationV2AppThread) =>
  event({ type: "thread.created", threadId: payload.id, occurredAt: payload.createdAt, payload });
const prompt = (threadId: ThreadId, key: string, at: DateTime.Utc, senderThreadId?: ThreadId) =>
  event({
    type: "message.updated",
    threadId,
    occurredAt: at,
    payload: {
      createdBy: "user",
      creationSource: "web",
      id: MessageId.make(`message:moments:${key}`),
      threadId,
      runId: null,
      nodeId: null,
      role: "user",
      text: `Prompt ${key}`,
      attachments: [],
      streaming: false,
      createdAt: at,
      updatedAt: at,
      ...(senderThreadId ? { senderThreadId } : {}),
    },
  });

const subscribe = (projectId: ProjectId, take: number) =>
  Effect.gen(function* () {
    const moments = yield* ProjectMoments.ProjectMoments;
    const snapshotSent = yield* Deferred.make<void>();
    const fiber = yield* moments.subscribe({ projectId }).pipe(
      Stream.tap((item) =>
        item.kind === "snapshot" ? Deferred.succeed(snapshotSent, undefined) : Effect.void,
      ),
      Stream.take(take),
      Stream.runCollect,
      Effect.forkChild,
    );
    yield* Deferred.await(snapshotSent);
    return fiber;
  });

const snapshotOf = (items: ReadonlyArray<ProjectMomentsStreamItem>) => {
  const [first] = items;
  assert.equal(first?.kind, "snapshot");
  return first as Extract<ProjectMomentsStreamItem, { kind: "snapshot" }>;
};

describe("ProjectMoments", () => {
  it.layer(layerTest)((it) => {
    it.effect("shows this project's recent top-level threads, then live changes", () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(NOW);
        const eventSink = yield* EventSink.EventSinkV2;
        const projectId = ProjectId.make("project:moments:scoped");
        const main = thread("main", projectId);
        const other = thread("other", ProjectId.make("project:moments:elsewhere"));
        const subagent = thread("subagent", projectId, {
          lineage: {
            parentThreadId: main.id,
            relationshipToParent: "subagent",
            rootThreadId: main.id,
          },
        });
        const sideChat = thread("side", projectId, {
          lineage: {
            parentThreadId: main.id,
            relationshipToParent: null,
            rootThreadId: main.id,
            sideChat: true,
          },
        });
        const deleted = thread("deleted", projectId);
        const opened = thread("opened", projectId);
        const late = thread("late", projectId);
        yield* eventSink.write({
          events: [
            ...[main, other, subagent, sideChat, deleted, opened, late].map(created),
            event({
              type: "thread.deleted",
              threadId: deleted.id,
              occurredAt: hoursAgo(5),
              payload: { ...deleted, deletedAt: hoursAgo(5) },
            }),
            prompt(main.id, "recent", hoursAgo(2)),
            prompt(main.id, "old", hoursAgo(24 * 8)),
            prompt(other.id, "other", hoursAgo(2)),
            prompt(subagent.id, "subagent", hoursAgo(2)),
            prompt(sideChat.id, "side", hoursAgo(2)),
            prompt(deleted.id, "deleted", hoursAgo(6)),
            prompt(opened.id, "first", hoursAgo(3)),
            prompt(opened.id, "second", hoursAgo(2)),
          ],
        });

        const fiber = yield* subscribe(projectId, 3);
        yield* eventSink.write({
          events: [
            prompt(late.id, "live", hoursAgo(0)),
            prompt(opened.id, "live-third", hoursAgo(0)),
            prompt(other.id, "live-other", hoursAgo(0)),
          ],
        });
        yield* eventSink.write({
          events: [
            event({
              type: "thread.deleted",
              threadId: main.id,
              occurredAt: hoursAgo(0),
              payload: { ...main, deletedAt: hoursAgo(0) },
            }),
          ],
        });
        const items = [...(yield* Fiber.join(fiber))];

        assert.deepStrictEqual(
          snapshotOf(items).moments.map((moment) => [moment.id, moment.threadTitle]),
          // main's first prompt is older than the window, so its recent one is not a start.
          [["thread-started:message:moments:first", "Thread opened"]],
        );
        assert.deepStrictEqual(items.slice(1), [
          {
            kind: "upsert",
            moment: {
              id: "thread-started:message:moments:live",
              kind: "thread-started",
              threadId: late.id,
              threadTitle: "Thread late",
              at: DateTime.formatIso(hoursAgo(0)),
              messageId: MessageId.make("message:moments:live"),
              snippet: "Prompt live",
              sender: { kind: "user", title: null },
            },
          },
          { kind: "remove-thread", threadId: main.id },
        ]);
      }),
    );

    it.effect("sends a renamed thread's moments again under its new title", () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(NOW);
        const eventSink = yield* EventSink.EventSinkV2;
        const projectId = ProjectId.make("project:moments:renamed");
        const named = thread("named", projectId);
        yield* eventSink.write({
          events: [created(named), prompt(named.id, "named", hoursAgo(1))],
        });
        const fiber = yield* subscribe(projectId, 2);
        yield* eventSink.write({
          events: [
            event({
              type: "thread.metadata-updated",
              threadId: named.id,
              occurredAt: hoursAgo(0),
              payload: { ...named, title: "Renamed" },
            }),
          ],
        });
        const items = [...(yield* Fiber.join(fiber))];
        assert.deepStrictEqual(
          items.map((item) =>
            item.kind === "upsert" ? [item.moment.id, item.moment.threadTitle] : item.kind,
          ),
          ["snapshot", ["thread-started:message:moments:named", "Renamed"]],
        );
      }),
    );

    it.effect("shows a stable move on the Inbox, at its wake note once one reports it", () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(NOW);
        const eventSink = yield* EventSink.EventSinkV2;
        const projectId = ProjectId.make("project:moments:stable");
        const inbox = thread("inbox", projectId, { title: "Inbox" });
        recordInboxThread(projectId, inbox.id);
        const move: InboxStableMove = {
          key: "stable:moments",
          projectId,
          commit: "1e161211f7b27f3498eda4948fdc041edc7b271b",
          pullRequests: [
            { number: 104, title: "One" },
            { number: 107, title: "Two" },
          ],
          webUrl: null,
          atMs: NOW - 60_000,
          noteMessageId: null,
        };
        const publish = (moves: ReadonlyArray<InboxStableMove>) =>
          publishInboxWakeState({ ...emptyInboxWakeState(0), stableMoves: moves });
        publish([move, { ...move, key: "other", projectId: ProjectId.make("project:other") }]);
        yield* eventSink.write({ events: [created(inbox)] });
        const fiber = yield* subscribe(projectId, 3);
        publish([{ ...move, noteMessageId: "note-1" }]);
        yield* eventSink.write({ events: [prompt(inbox.id, "inbox", hoursAgo(0))] });
        const items = [...(yield* Fiber.join(fiber))];
        publish([]);

        const card = {
          id: `stable-moved:${move.commit}`,
          kind: "stable-moved",
          threadId: inbox.id,
          threadTitle: "Inbox",
          at: DateTime.formatIso(DateTime.makeUnsafe(move.atMs)),
          messageId: null,
          snippet: "#104, #107",
        } as const;
        assert.deepStrictEqual(snapshotOf(items).moments, [card]);
        assert.deepStrictEqual(items[1], {
          kind: "upsert",
          moment: { ...card, messageId: MessageId.make("note-1") },
        });
      }),
    );

    it.effect("keeps the newest moments within the limit", () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(NOW);
        const eventSink = yield* EventSink.EventSinkV2;
        const projectId = ProjectId.make("project:moments:capped");
        const busy = thread("busy", projectId);
        yield* eventSink.write({
          events: [
            created(busy),
            ...Array.from({ length: 301 }, (_, index) =>
              prompt(busy.id, `busy:${index}`, hoursAgo(100 - index * 0.25), busy.id),
            ),
          ],
        });
        const fiber = yield* subscribe(projectId, 1);
        const snapshot = snapshotOf([...(yield* Fiber.join(fiber))]);
        assert.equal(snapshot.truncated, true);
        assert.equal(snapshot.moments.length, 300);
        assert.equal(snapshot.moments[0]?.id, "agent-in:message:moments:busy:1");
        assert.equal(snapshot.moments.at(-1)?.id, "agent-in:message:moments:busy:300");
      }),
    );
  });
});
