import type {
  BoardColumn,
  BoardIssue,
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

export type BoardIssueTarget =
  | { readonly kind: "thread"; readonly ref: ScopedThreadRef }
  | { readonly kind: "linear"; readonly url: string };

/** A linked thread opens in place when this client is connected to its environment. */
export function boardIssueTarget(
  issue: Pick<BoardIssue, "thread" | "url">,
  connectedEnvironmentIds: ReadonlySet<EnvironmentId>,
): BoardIssueTarget {
  if (issue.thread !== null && connectedEnvironmentIds.has(issue.thread.environmentId)) {
    return {
      kind: "thread",
      ref: scopeThreadRef(issue.thread.environmentId, issue.thread.threadId),
    };
  }
  return { kind: "linear", url: issue.url };
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
