import {
  CommandId,
  MessageId,
  type OrchestrationV2DomainEvent,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { boardTaskChange } from "../board/linearToolCalls.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { forkParked } from "../serverActivation.ts";
import {
  buildInboxAgentDigest,
  inboxAgentDigestSinceMs,
  withInboxAgentDigestRecord,
} from "./inboxAgentDigest.ts";
import { inboxThreadOf, inboxThreads, isInboxThread } from "./inboxAgentThreads.ts";
import {
  INBOX_WAKE_CREATED_BY,
  INBOX_WAKE_CREATION_SOURCE,
  InboxWakeState,
  emptyInboxWakeState,
  inboxWakeEvents,
  inboxWakeText,
  inboxWakeTiming,
  isInboxReportedThread,
  lastInboxWakeMs,
  prunedInboxWakeState,
  publishInboxWakeState,
  withInboxTaskCompletion,
  withInboxWake,
} from "./inboxAgentWake.ts";

const TICK = Duration.seconds(30);

const StateFile = Schema.fromJsonString(InboxWakeState);
const decodeState = Schema.decodeUnknownOption(StateFile);
const encodeState = Schema.encodeSync(StateFile);

type Input =
  | { readonly _tag: "event"; readonly event: OrchestrationV2DomainEvent }
  | { readonly _tag: "tick" };

/**
 * Wakes a project's Inbox with a short note when, in another of its threads, a question starts
 * waiting, a pull request is merged or an agent completes a Board task (see `inboxWakeTiming`).
 * Events and ticks are handled one at a time, so the state needs no lock.
 */
const watch = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const engine = yield* Orchestrator.OrchestratorV2;
  const environmentId = yield* (yield* ServerEnvironment.ServerEnvironment).getEnvironmentId;

  const statePath = path.join(config.stateDir, "inbox-agent", "wake.json");
  const startMs = yield* Clock.currentTimeMillis;
  const loaded = yield* fs.readFileString(statePath).pipe(
    Effect.map((text) => decodeState(text)),
    Effect.orElseSucceed(() => undefined),
  );
  let state = prunedInboxWakeState(
    loaded?._tag === "Some" ? loaded.value : emptyInboxWakeState(startMs),
    startMs,
  );
  publishInboxWakeState(state);
  const save = fs.makeDirectory(path.dirname(statePath), { recursive: true }).pipe(
    Effect.andThen(
      Effect.suspend(() => fs.writeFileString(statePath, encodeState(state), { mode: 0o600 })),
    ),
    Effect.tapError((cause) => Effect.logWarning("The Inbox wake state was not written.", cause)),
    Effect.ignore,
  );
  const update = (next: InboxWakeState) => {
    state = next;
    publishInboxWakeState(state);
    return save;
  };

  // Threads that changed since the last tick, and per project when news was first seen.
  const changedThreads = new Set<ThreadId>();
  const firstSeen = new Map<ProjectId, number>();

  const recordTask = Effect.fnUntraced(
    function* (event: Extract<OrchestrationV2DomainEvent, { readonly type: "turn-item.updated" }>) {
      const change = boardTaskChange(event.payload);
      const key = event.payload.id;
      if (change?.kind !== "status" || change.statusType !== "completed") return;
      if (state.tasks.some((task) => task.key === key)) return;
      const shell = yield* threads.getThreadShell(event.threadId);
      const inboxThreadId = shell === null ? undefined : inboxThreadOf(shell.projectId);
      if (
        shell === null ||
        inboxThreadId === undefined ||
        !isInboxReportedThread(shell, shell.projectId, inboxThreadId)
      ) {
        return;
      }
      yield* update(
        withInboxTaskCompletion(state, {
          key,
          projectId: shell.projectId,
          threadId: shell.id,
          identifier: change.identifier,
          title: change.title,
          url: change.url,
          atMs: DateTime.toEpochMillis(event.occurredAt),
        }),
      );
      changedThreads.add(shell.id);
    },
    Effect.catchCause((cause) =>
      Effect.logWarning("The Inbox wake missed a completed task.", cause),
    ),
  );

  // Per event, so no span: the stream carries every event of every thread.
  const onEvent = (event: OrchestrationV2DomainEvent): Effect.Effect<void> => {
    if (isInboxThread(event.threadId)) return Effect.void;
    switch (event.type) {
      case "turn-item.updated":
        // A waiting card is a question the shell shows as a pending request.
        if (event.payload.status === "waiting") changedThreads.add(event.threadId);
        return event.payload.type === "dynamic_tool" && event.payload.status === "completed"
          ? recordTask(event)
          : Effect.void;
      case "message.updated":
        if (event.payload.role === "assistant" && !event.payload.streaming) {
          changedThreads.add(event.threadId);
        }
        return Effect.void;
      case "runtime-request.updated":
      case "thread.pull-request-synced":
      case "thread.pull-request-link-updated":
        changedThreads.add(event.threadId);
        return Effect.void;
      default:
        return Effect.void;
    }
  };

  /** Notes which projects have news in the threads that changed; reads only those threads. */
  const noteChanged = Effect.fn("InboxWakeWatch.noteChanged")(function* (nowMs: number) {
    if (changedThreads.size === 0) return;
    const threadIds = [...changedThreads];
    changedThreads.clear();
    const { threads: shells } = yield* threads.getShellSnapshot({ threadIds });
    for (const projectId of new Set(shells.map((shell) => shell.projectId))) {
      const inboxThreadId = inboxThreadOf(projectId);
      if (inboxThreadId === undefined || firstSeen.has(projectId)) continue;
      const events = inboxWakeEvents({
        shells,
        projectId,
        inboxThreadId,
        tasks: state.tasks,
        reported: state.reported,
        sinceMs: state.startedAtMs,
        nowMs,
      });
      if (events.length > 0) firstSeen.set(projectId, nowMs);
    }
  });

  /** Wakes the project's Inbox with its news; "running" keeps the news for the next tick. */
  const wake = Effect.fn("InboxWakeWatch.wake")(function* (projectId: ProjectId, nowMs: number) {
    const inboxThreadId = inboxThreadOf(projectId);
    if (inboxThreadId === undefined) return "nothing" as const;
    const inbox = yield* threads.getThreadShell(inboxThreadId);
    if (inbox === null || inbox.deletedAt != null || inbox.archivedAt !== null) {
      return "nothing" as const;
    }
    if (inbox.activeRunId !== null) return "running" as const;
    const userMs =
      inbox.latestUserAuthoredMessageAt == null
        ? state.startedAtMs
        : DateTime.toEpochMillis(inbox.latestUserAuthoredMessageAt);
    const { threads: shells } = yield* threads.getShellSnapshot({ projectId });
    const events = inboxWakeEvents({
      shells,
      projectId,
      inboxThreadId,
      tasks: state.tasks,
      reported: state.reported,
      // What the user's own message already showed them is not news.
      sinceMs: Math.max(state.startedAtMs, userMs),
      nowMs,
    });
    if (events.length === 0) return "nothing" as const;
    // An event can be seen after a later wake (a merge synced late): the card still shows it.
    const sinceMs = Math.min(
      inboxAgentDigestSinceMs(inbox, nowMs, lastInboxWakeMs(projectId)),
      Math.min(...events.map((event) => event.atMs)) - 1,
    );
    const digest = yield* buildInboxAgentDigest({ inbox, sinceMs, untilMs: nowMs });
    const context = withInboxAgentDigestRecord(undefined, digest);
    const id = `inbox-wake:${inboxThreadId}:${nowMs}`;
    yield* threads.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(id),
      threadId: inboxThreadId,
      messageId: MessageId.make(id),
      text: inboxWakeText(events, environmentId),
      ...(context === undefined ? {} : { context }),
      attachments: [],
      dispatchMode: { type: "queue_after_active" },
      createdBy: INBOX_WAKE_CREATED_BY,
      creationSource: INBOX_WAKE_CREATION_SOURCE,
    });
    yield* update(prunedInboxWakeState(withInboxWake(state, { projectId, events, nowMs }), nowMs));
    yield* Effect.logInfo("Woke the project's Inbox.", { projectId, events: events.length });
    return "woken" as const;
  });

  const onTick = Effect.fn("InboxWakeWatch.tick")(function* () {
    const nowMs = yield* Clock.currentTimeMillis;
    yield* noteChanged(nowMs).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("The Inbox wake could not read threads.", cause),
      ),
    );
    for (const [projectId, firstSeenMs] of firstSeen) {
      const timing = inboxWakeTiming({ nowMs, firstSeenMs, wakesMs: state.wakes[projectId] ?? [] });
      if (timing !== "due") continue;
      const outcome = yield* wake(projectId, nowMs).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("The project's Inbox could not be woken.", { projectId, cause }).pipe(
            Effect.as("failed" as const),
          ),
        ),
      );
      // A failed wake keeps its news and tries again a batch's length later.
      if (outcome === "failed") firstSeen.set(projectId, nowMs);
      else if (outcome !== "running") firstSeen.delete(projectId);
    }
  });

  yield* forkParked(
    Effect.gen(function* () {
      // News that came while the server was stopped: each Inbox is checked once at the first due tick.
      const nowMs = yield* Clock.currentTimeMillis;
      for (const projectId of inboxThreads().keys()) firstSeen.set(projectId, nowMs);
      yield* Stream.runForEach(
        Stream.merge(
          engine.streamDomainEvents.pipe(Stream.map((event): Input => ({ _tag: "event", event }))),
          Stream.tick(TICK).pipe(Stream.map((): Input => ({ _tag: "tick" }))),
        ),
        (input) => (input._tag === "tick" ? onTick() : onEvent(input.event)),
      );
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("The Inbox stopped watching for news.", cause),
      ),
    ),
  );
});

export const layer = Layer.effectDiscard(watch);
