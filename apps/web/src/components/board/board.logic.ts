import type {
  BoardColumn,
  BoardIssue,
  BoardPriority,
  BoardThreadLink,
  EnvironmentId,
  PullRequestChecksState,
  PullRequestReviewDecision,
  PullRequestState,
  ScopedThreadRef,
  ThreadPullRequestSnapshot,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";

export type BoardView = "board" | "list";
export type BoardFilter = "all" | "mine";

/** Columns with only the issues the filter keeps; every column stays, so the layout holds. */
export function filterBoardColumns(
  columns: ReadonlyArray<BoardColumn>,
  filter: BoardFilter,
): ReadonlyArray<BoardColumn> {
  if (filter === "all") return columns;
  return columns.map((column) => ({
    state: column.state,
    issues: column.issues.filter((issue) => issue.assignee?.isMe === true),
  }));
}

export type BoardThreadTarget =
  | { readonly kind: "thread"; readonly ref: ScopedThreadRef }
  | { readonly kind: "unreachable" };

/** A linked thread opens in place when this client is connected to its environment. */
export function boardThreadTarget(
  thread: Pick<BoardThreadLink, "environmentId" | "threadId">,
  connectedEnvironmentIds: ReadonlySet<EnvironmentId>,
): BoardThreadTarget {
  return connectedEnvironmentIds.has(thread.environmentId)
    ? { kind: "thread", ref: scopeThreadRef(thread.environmentId, thread.threadId) }
    : { kind: "unreachable" };
}

/** The thread a card shows: the newest one this client reaches, else the newest. */
export function boardCardThread(
  threads: ReadonlyArray<BoardThreadLink>,
  connectedEnvironmentIds: ReadonlySet<EnvironmentId>,
): BoardThreadLink | null {
  return (
    threads.find((thread) => connectedEnvironmentIds.has(thread.environmentId)) ??
    threads[0] ??
    null
  );
}

export const BOARD_PRIORITY_LABELS: Record<BoardPriority, string> = {
  0: "No priority",
  1: "Urgent",
  2: "High",
  3: "Medium",
  4: "Low",
};

/** In progress shows when the work started; anything else when the issue last changed. */
export function boardIssueTime(
  issue: Pick<BoardIssue, "startedAt" | "updatedAt">,
  stateType: string,
): { readonly verb: "started" | "updated"; readonly at: string } {
  return stateType === "started" && issue.startedAt !== null
    ? { verb: "started", at: issue.startedAt }
    : { verb: "updated", at: issue.updatedAt };
}

export interface BoardPullRequestStatus {
  readonly state: PullRequestState;
  readonly isDraft: boolean;
  readonly checksState: PullRequestChecksState | null;
  readonly reviewDecision: PullRequestReviewDecision | null;
}

const LINEAR_STATUSES: Record<string, Pick<BoardPullRequestStatus, "state" | "isDraft">> = {
  open: { state: "open", isDraft: false },
  draft: { state: "open", isDraft: true },
  inreview: { state: "open", isDraft: false },
  approved: { state: "open", isDraft: false },
  merged: { state: "merged", isDraft: false },
  closed: { state: "closed", isDraft: false },
};

/** T3 Code's own synced state when it tracks the pull request, else what Linear recorded. */
export function boardPullRequestStatus(
  snapshot: ThreadPullRequestSnapshot | null | undefined,
  linearStatus: string | null,
): BoardPullRequestStatus | null {
  if (snapshot) {
    return {
      state: snapshot.state,
      isDraft: snapshot.isDraft,
      checksState: snapshot.checksState ?? null,
      reviewDecision: snapshot.reviewDecision ?? null,
    };
  }
  const known = LINEAR_STATUSES[linearStatus?.toLowerCase().replace(/[\s_-]/g, "") ?? ""];
  return known ? { ...known, checksState: null, reviewDecision: null } : null;
}
