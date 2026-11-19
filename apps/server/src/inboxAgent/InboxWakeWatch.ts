import {
  CommandId,
  MessageId,
  type OrchestrationV2DomainEvent,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { boardTaskChange } from "../board/linearToolCalls.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { forkParked } from "../serverActivation.ts";
import { unsetInheritedRepositoryEnv } from "../vcs/VcsProcess.ts";
import {
  buildInboxAgentDigest,
  inboxAgentDigestSinceMs,
  withInboxAgentDigestRecord,
} from "./inboxAgentDigest.ts";
import { inboxThreadOf, inboxThreads, isInboxThread } from "./inboxAgentThreads.ts";
import {
  INBOX_WAKE_CREATED_BY,
  INBOX_WAKE_CREATION_SOURCE,
  type InboxStableMove,
  InboxWakeState,
  emptyInboxWakeState,
  inboxWakeEvents,
  inboxWakeText,
  inboxWakeTiming,
  isInboxReportedThread,
  lastInboxWakeMs,
  prunedInboxWakeState,
  publishInboxWakeState,
  withInboxStableCheck,
  withInboxTaskCompletion,
  withInboxWake,
} from "./inboxAgentWake.ts";
import {
  STABLE_CHECK_INTERVAL_MS,
  readStableCommit,
  readStablePullRequests,
  stableRepositoryWebUrl,
} from "./stableTag.ts";

const TICK = Duration.seconds(30);

const StateFile = Schema.fromJsonString(InboxWakeState);
const decodeState = Schema.decodeUnknownOption(StateFile);
const encodeState = Schema.encodeSync(StateFile);

interface StableCheck {
  readonly projectId: ProjectId;
  readonly commit: string | null;
  readonly move: Pick<InboxStableMove, "pullRequests" | "webUrl" | "atMs"> | null;
}

type Input =
  | { readonly _tag: "event"; readonly event: OrchestrationV2DomainEvent }
  | { readonly _tag: "tick" }
  | { readonly _tag: "stable"; readonly check: StableCheck };

/**
 * Wakes a project's Inbox with a short note when, in another of its threads, a question starts
 * waiting, a pull request is merged or an agent completes a Board task, or when the project's
 * `stable` tag moves (see `inboxWakeTiming`). Events, ticks and tag checks are handled one at a
 * time, so the state needs no lock; only the tag's git reads run beside them.
 */
const watch = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const engine = yield* Orchestrator.OrchestratorV2;
  const environmentId = yield* (yield* ServerEnvironment.ServerEnvironment).getEnvironmentId;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const identities = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
  const gitEnv = {
    ...unsetInheritedRepositoryEnv(process.env, yield* HostProcess.Platform),
    // No terminal can answer a credential prompt; fail instead of waiting for the timeout.
    GIT_TERMINAL_PROMPT: "0",
  };

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
      stableMoves: state.stableMoves,
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
    yield* update(
      prunedInboxWakeState(
        withInboxWake(state, { projectId, events, nowMs, messageId: id }),
        nowMs,
      ),
    );
    yield* Effect.logInfo("Woke the project's Inbox.", { projectId, events: events.length });
    return "woken" as const;
  });

  /** Reads what `stable` names on the project's origin, and the pull requests of a move. */
  const readStable = Effect.fn("InboxWakeWatch.readStable")(function* (projectId: ProjectId) {
    const project = yield* projects
      .get(projectId)
      .pipe(Effect.orElseSucceed(() => Option.none<ProjectStore.ProjectRow>()));
    if (Option.isNone(project)) return null;
    const cwd = project.value.workspaceRoot;
    const commit = yield* readStableCommit(processRunner.run, cwd, gitEnv);
    const previous = state.stable[projectId];
    if (commit === null || previous === undefined || previous === commit) {
      return { projectId, commit, move: null } satisfies StableCheck;
    }
    const pullRequests = yield* readStablePullRequests(processRunner.run, cwd, gitEnv, {
      from: previous,
      to: commit,
    }).pipe(Effect.orElseSucceed(() => []));
    const identity = yield* identities.resolve(cwd);
    const webUrl = stableRepositoryWebUrl(identity);
    const atMs = yield* Clock.currentTimeMillis;
    return { projectId, commit, move: { pullRequests, webUrl, atMs } } satisfies StableCheck;
  });

  // Suspended: Inboxes made after startup are checked too.
  const readAllStable = Effect.suspend(() =>
    Effect.forEach(
      [...inboxThreads().keys()],
      (projectId) =>
        readStable(projectId).pipe(
          // A folder that is not a git checkout, or has no origin, fails here every check.
          Effect.catchCause((cause) =>
            Effect.logDebug("The stable tag was not read.", { projectId, cause }).pipe(
              Effect.as(null),
            ),
          ),
        ),
      { concurrency: 2 },
    ),
  ).pipe(Effect.map((checks) => checks.filter((check) => check !== null)));

  const onStable = Effect.fn("InboxWakeWatch.stable")(function* (check: StableCheck) {
    if ((state.stable[check.projectId] ?? null) === check.commit && check.move === null) return;
    yield* update(withInboxStableCheck(state, check));
    if (check.move === null) return;
    yield* Effect.logInfo("The stable tag moved.", {
      projectId: check.projectId,
      pullRequests: check.move.pullRequests.length,
    });
    if (!firstSeen.has(check.projectId)) firstSeen.set(check.projectId, check.move.atMs);
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
        Stream.mergeAll(
          [
            engine.streamDomainEvents.pipe(
              Stream.map((event): Input => ({ _tag: "event", event })),
            ),
            Stream.tick(TICK).pipe(Stream.map((): Input => ({ _tag: "tick" }))),
            Stream.tick(Duration.millis(STABLE_CHECK_INTERVAL_MS)).pipe(
              Stream.mapEffect(() => readAllStable),
              Stream.flattenIterable,
              Stream.map((check): Input => ({ _tag: "stable", check })),
            ),
          ],
          { concurrency: "unbounded" },
        ),
        (input) =>
          input._tag === "tick"
            ? onTick()
            : input._tag === "stable"
              ? onStable(input.check)
              : onEvent(input.event),
      );
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("The Inbox stopped watching for news.", cause),
      ),
    ),
  );
});

export const layer = Layer.effectDiscard(watch);
