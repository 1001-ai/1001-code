import {
  type EnvironmentId,
  INBOX_AGENT_DIGEST_DETAIL_MAX_LENGTH,
  INBOX_AGENT_DIGEST_TITLE_MAX_LENGTH,
  type OrchestrationV2ThreadShell,
  ProjectId,
  ThreadId,
  isListedThreadLineage,
} from "@t3tools/contracts";
import { inboxAgentPlainText } from "@t3tools/provider-core/server/runtimeInstructions";
import { formatThreadLink } from "@t3tools/shared/threadLinks";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

import { isInboxThread } from "./inboxAgentThreads.ts";

/**
 * When the server wakes a project's Inbox on its own: a question starts waiting for the user, a
 * pull request is merged or an agent completes a Board task in another thread of the project, or
 * the project's `stable` tag moves to a new build.
 * Everything here is pure; `InboxWakeWatch` does the reading, writing and dispatching.
 */

/** The wake note's first words; the Inbox's instructions describe them. */
export const INBOX_WAKE_MARKER = "[Inbox update]";
/** A server-made message, as the usage-limit and delegated-task wakes stamp theirs: never the user's. */
export const INBOX_WAKE_CREATED_BY = "agent";
export const INBOX_WAKE_CREATION_SOURCE = "server";

/** Events seen within this long go out together. */
export const INBOX_WAKE_BATCH_MS = 2 * 60_000;
const MIN_INTERVAL_MS = 2 * 60_000;
/** Per project, in any 24 hours. */
export const INBOX_WAKE_DAILY_CAP = 40;
const DAY_MS = 24 * 60 * 60_000;
/** Older events are never reported, so a long-stopped server does not wake with old news. */
const LOOKBACK_MS = DAY_MS;
/** The digest reads completed tasks back to the user's previous message; a week is plenty. */
const TASK_KEEP_MS = 7 * DAY_MS;
const MAX_WAKE_LINES = 10;

/** An agent's Board write that moved a task to a completed state, as the server saw it. */
export const InboxTaskCompletion = Schema.Struct({
  /** The tool item's id: one item reports once however often it is updated. */
  key: Schema.String,
  projectId: ProjectId,
  threadId: ThreadId,
  /** Such as ENG-12. */
  identifier: Schema.String,
  title: Schema.String,
  url: Schema.String,
  atMs: Schema.Number,
});
export type InboxTaskCompletion = typeof InboxTaskCompletion.Type;

/** The project's `stable` tag moved on its origin, as the server's own check saw it. */
export const InboxStableMove = Schema.Struct({
  key: Schema.String,
  projectId: ProjectId,
  /** The commit it moved to. */
  commit: Schema.String,
  /** Oldest first; empty when the range could not be read. */
  pullRequests: Schema.Array(Schema.Struct({ number: Schema.Number, title: Schema.String })),
  /** The repository's web address, for pull request links; null when not on GitHub. */
  webUrl: Schema.NullOr(Schema.String),
  atMs: Schema.Number,
  /** The wake note that reported it, once one did. */
  noteMessageId: Schema.NullOr(Schema.String),
});
export type InboxStableMove = typeof InboxStableMove.Type;

/** Kept in the state directory, so a restart neither reports an event again nor resets the cap. */
export const InboxWakeState = Schema.Struct({
  version: Schema.Literal(2),
  /** Events from before the first start are old news. */
  startedAtMs: Schema.Number,
  /** Each reported event's key, with the event's time. */
  reported: Schema.Record(Schema.String, Schema.Number),
  /** Per project id, when it was woken in the last day. */
  wakes: Schema.Record(Schema.String, Schema.Array(Schema.Number)),
  tasks: Schema.Array(InboxTaskCompletion),
  /** Per project id, the commit `stable` named at the last check. */
  stable: Schema.Record(Schema.String, Schema.String),
  stableMoves: Schema.Array(InboxStableMove),
});
export type InboxWakeState = typeof InboxWakeState.Type;

export const emptyInboxWakeState = (nowMs: number): InboxWakeState => ({
  version: 2,
  startedAtMs: nowMs,
  reported: {},
  wakes: {},
  tasks: [],
  stable: {},
  stableMoves: [],
});

/** Drops what can no longer matter: keys past the lookback, wakes past a day, tasks and moves past a week. */
export function prunedInboxWakeState(state: InboxWakeState, nowMs: number): InboxWakeState {
  const reported = Object.fromEntries(
    Object.entries(state.reported).filter(([, atMs]) => nowMs - atMs < LOOKBACK_MS + DAY_MS),
  );
  const wakes = Object.fromEntries(
    Object.entries(state.wakes)
      .map(([projectId, times]) => [projectId, times.filter((ms) => nowMs - ms < DAY_MS)] as const)
      .filter(([, times]) => times.length > 0),
  );
  const tasks = state.tasks.filter((task) => nowMs - task.atMs < TASK_KEEP_MS);
  const stableMoves = state.stableMoves.filter((move) => nowMs - move.atMs < TASK_KEEP_MS);
  return { ...state, reported, wakes, tasks, stableMoves };
}

/** Adds a completed task once; the same tool item updated again is not a second completion. */
export function withInboxTaskCompletion(
  state: InboxWakeState,
  task: InboxTaskCompletion,
): InboxWakeState {
  return state.tasks.some((known) => known.key === task.key)
    ? state
    : { ...state, tasks: [...state.tasks, task] };
}

/**
 * Records what `stable` named at a check. A change from a known commit is a move; the first
 * commit seen for a project, or a tag that disappeared, is only remembered.
 */
export function withInboxStableCheck(
  state: InboxWakeState,
  check: {
    readonly projectId: ProjectId;
    readonly commit: string | null;
    readonly move: Omit<InboxStableMove, "key" | "projectId" | "commit" | "noteMessageId"> | null;
  },
): InboxWakeState {
  const { [check.projectId]: _previous, ...others } = state.stable;
  if (check.commit === null) return { ...state, stable: others };
  const stable = { ...others, [check.projectId]: check.commit };
  if (check.move === null) return { ...state, stable };
  const key = `stable:${check.projectId}:${check.commit}`;
  if (state.stableMoves.some((move) => move.key === key)) return { ...state, stable };
  const move: InboxStableMove = {
    ...check.move,
    key,
    projectId: check.projectId,
    commit: check.commit,
    noteMessageId: null,
  };
  return { ...state, stable, stableMoves: [...state.stableMoves, move] };
}

/** Records a wake: its events are reported and it counts toward the caps. */
export function withInboxWake(
  state: InboxWakeState,
  wake: {
    readonly projectId: ProjectId;
    readonly events: ReadonlyArray<InboxWakeEvent>;
    readonly nowMs: number;
    readonly messageId: string;
  },
): InboxWakeState {
  const reportedKeys = new Set(wake.events.map((event) => event.key));
  return {
    ...state,
    stableMoves: state.stableMoves.map((move) =>
      reportedKeys.has(move.key) && move.noteMessageId === null
        ? { ...move, noteMessageId: wake.messageId }
        : move,
    ),
    reported: {
      ...state.reported,
      ...Object.fromEntries(wake.events.map((event) => [event.key, event.atMs])),
    },
    wakes: {
      ...state.wakes,
      [wake.projectId]: [...(state.wakes[wake.projectId] ?? []), wake.nowMs],
    },
  };
}

// Published process-wide, as the Linear inbox's log is: the digest is built in upstream intake
// code that cannot take a new service. Only `InboxWakeWatch` writes it.
let published: InboxWakeState | null = null;

export function publishInboxWakeState(state: InboxWakeState): void {
  published = state;
}

export function inboxTaskCompletions(): ReadonlyArray<InboxTaskCompletion> {
  return published?.tasks ?? [];
}

export function inboxStableMoves(): ReadonlyArray<InboxStableMove> {
  return published?.stableMoves ?? [];
}

/** When the app last woke the project's Inbox, or null. */
export function lastInboxWakeMs(projectId: ProjectId): number | null {
  const times = published?.wakes[projectId] ?? [];
  return times.length === 0 ? null : Math.max(...times);
}

/** A thread the Inbox reports on: a listed thread of its project, never an Inbox. */
export function isInboxReportedThread(
  shell: Pick<OrchestrationV2ThreadShell, "id" | "projectId" | "lineage">,
  projectId: ProjectId,
  inboxThreadId: ThreadId,
): boolean {
  return (
    shell.projectId === projectId &&
    shell.id !== inboxThreadId &&
    !isInboxThread(shell.id) &&
    isListedThreadLineage(shell.lineage)
  );
}

export interface InboxWakeEvent {
  readonly key: string;
  readonly kind: "question" | "pull-request-merged" | "task-completed" | "stable-moved";
  readonly threadId: ThreadId;
  readonly title: string;
  readonly atMs: number;
  readonly detail: string;
}

type WakeShell = Pick<
  OrchestrationV2ThreadShell,
  | "id"
  | "projectId"
  | "title"
  | "lineage"
  | "openQuestionsAt"
  | "pendingRuntimeRequest"
  | "pullRequests"
>;

/**
 * The events to report for one project: new since `sinceMs` (and the lookback), not reported
 * yet, from what the shells show now, so a question answered meanwhile is not reported. Questions
 * first, then newest first.
 */
export function inboxWakeEvents(input: {
  readonly shells: ReadonlyArray<WakeShell>;
  readonly projectId: ProjectId;
  readonly inboxThreadId: ThreadId;
  readonly tasks: ReadonlyArray<InboxTaskCompletion>;
  readonly stableMoves?: ReadonlyArray<InboxStableMove>;
  readonly reported: Readonly<Record<string, number>>;
  readonly sinceMs: number;
  readonly nowMs: number;
}): ReadonlyArray<InboxWakeEvent> {
  const fromMs = Math.max(input.sinceMs, input.nowMs - LOOKBACK_MS);
  const events: InboxWakeEvent[] = [];
  const add = (event: InboxWakeEvent) => {
    if (event.atMs > fromMs && event.atMs <= input.nowMs && !(event.key in input.reported)) {
      events.push(event);
    }
  };
  const titles = new Map<ThreadId, string>();
  for (const shell of input.shells) {
    if (!isInboxReportedThread(shell, input.projectId, input.inboxThreadId)) continue;
    titles.set(shell.id, shell.title);
    const base = { threadId: shell.id, title: shell.title };
    if (shell.openQuestionsAt != null) {
      const atMs = DateTime.toEpochMillis(shell.openQuestionsAt);
      add({
        ...base,
        key: `question:${shell.id}:${atMs}`,
        kind: "question",
        atMs,
        detail: "asks the user a question",
      });
    }
    const request = shell.pendingRuntimeRequest;
    if (request != null && request.kind !== "auth_refresh") {
      add({
        ...base,
        key: `request:${shell.id}:${request.id}`,
        kind: "question",
        atMs: DateTime.toEpochMillis(request.createdAt),
        detail:
          request.kind === "user_input" ? "asks the user a question" : "waits for an approval",
      });
    }
    for (const link of shell.pullRequests ?? []) {
      const snapshot = link.snapshot;
      if (link.source === "stack-dismissed" || snapshot?.state !== "merged") continue;
      const atMs = Date.parse(snapshot.mergedAt ?? snapshot.syncedAt);
      if (Number.isNaN(atMs)) continue;
      add({
        ...base,
        key: `merged:${shell.id}:${link.url}`,
        kind: "pull-request-merged",
        atMs,
        detail: `${link.url} ${snapshot.title}`,
      });
    }
  }
  for (const task of input.tasks) {
    const title = titles.get(task.threadId);
    if (task.projectId !== input.projectId || title === undefined) continue;
    add({
      key: `task:${task.key}`,
      kind: "task-completed",
      threadId: task.threadId,
      title,
      atMs: task.atMs,
      detail: inboxTaskDetail(task),
    });
  }
  for (const move of input.stableMoves ?? []) {
    if (move.projectId !== input.projectId) continue;
    add({
      key: move.key,
      kind: "stable-moved",
      threadId: input.inboxThreadId,
      title: "",
      atMs: move.atMs,
      detail: inboxStableMoveText(move),
    });
  }
  return events.sort(
    (left, right) =>
      Number(right.kind === "question") - Number(left.kind === "question") ||
      right.atMs - left.atMs,
  );
}

export const shortCommit = (commit: string) => commit.slice(0, 7);

/** A move's pull requests as markdown links where the repository is on GitHub. */
function stablePullRequestLinks(move: Pick<InboxStableMove, "pullRequests" | "webUrl">): string {
  return move.pullRequests
    .map((pr) => {
      const label = `#${pr.number}`;
      const link = move.webUrl === null ? label : `[${label}](${move.webUrl}/pull/${pr.number})`;
      // A commit title is anyone's text: no brackets, so it cannot add a link of its own.
      const title = inboxAgentPlainText(pr.title.replaceAll(/[[\]]/g, "")).trim();
      return title === "" ? link : `${link} ${title}`;
    })
    .join(", ");
}

/** The wake note's line for a move, after "New build: ". */
function inboxStableMoveText(
  move: Pick<InboxStableMove, "commit" | "pullRequests" | "webUrl">,
): string {
  const moved = `\`stable\` moved to \`${shortCommit(move.commit)}\``;
  const prs = stablePullRequestLinks(move);
  return `${moved}${prs === "" ? "" : ` with ${prs}`}. Run your update command to get it.`;
}

/** The pull request numbers of a move, for its timeline card. */
export const inboxStableMoveNumbers = (move: Pick<InboxStableMove, "pullRequests">) =>
  move.pullRequests.map((pr) => `#${pr.number}`).join(", ");

export const inboxTaskDetail = (task: Pick<InboxTaskCompletion, "identifier" | "title" | "url">) =>
  `${task.identifier} ${task.title} ${task.url}`;

/**
 * Whether a project with events may be woken now: once its first event waited a batch's length,
 * not within the minimum interval of its last wake, and under the daily cap.
 */
export function inboxWakeTiming(input: {
  readonly nowMs: number;
  readonly firstSeenMs: number;
  readonly wakesMs: ReadonlyArray<number>;
}): "due" | "wait" | "capped" {
  if (input.nowMs - input.firstSeenMs < INBOX_WAKE_BATCH_MS) return "wait";
  const recent = input.wakesMs.filter((ms) => input.nowMs - ms < DAY_MS);
  if (recent.length >= INBOX_WAKE_DAILY_CAP) return "capped";
  return recent.some((ms) => input.nowMs - ms < MIN_INTERVAL_MS) ? "wait" : "due";
}

const KIND_TEXT: Record<InboxWakeEvent["kind"], string> = {
  question: "Waiting for you",
  "pull-request-merged": "Pull request merged",
  "task-completed": "Task completed",
  "stable-moved": "New build",
};

function clip(text: string, max: number): string {
  const plain = inboxAgentPlainText(text);
  return plain.length <= max ? plain : `${plain.slice(0, max - 1)}…`;
}

/**
 * The wake note: the marker line, then one line per event with the thread as a link. Plain
 * markdown, so it reads as an ordinary message in every client.
 */
export function inboxWakeText(
  events: ReadonlyArray<InboxWakeEvent>,
  environmentId: EnvironmentId,
): string {
  const lines = events.slice(0, MAX_WAKE_LINES).map((event) => {
    // Not a thread's news, and its links are the line itself: never clipped.
    if (event.kind === "stable-moved") return `- ${KIND_TEXT[event.kind]}: ${event.detail}`;
    const link = formatThreadLink(
      { environmentId, threadId: event.threadId },
      clip(event.title, INBOX_AGENT_DIGEST_TITLE_MAX_LENGTH) || event.threadId,
    );
    return `- ${KIND_TEXT[event.kind]}: ${link}: ${clip(event.detail, INBOX_AGENT_DIGEST_DETAIL_MAX_LENGTH)}`;
  });
  const more = events.length - MAX_WAKE_LINES;
  if (more > 0) lines.push(`- and ${more} more`);
  const count = `${events.length} ${events.length === 1 ? "change" : "changes"}`;
  return `${INBOX_WAKE_MARKER} ${count} in this project's threads:\n${lines.join("\n")}`;
}
