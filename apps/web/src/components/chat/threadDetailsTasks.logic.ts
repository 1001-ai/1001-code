import type {
  BoardIssue,
  BoardSnapshot,
  BoardWorkflowState,
  EnvironmentId,
  ThreadId,
} from "@t3tools/contracts";

export interface ThreadBoardTask {
  readonly issue: BoardIssue;
  readonly state: BoardWorkflowState;
}

/** The board's issues that link this thread, each with its column's state, in board order. */
export function threadBoardTasks(
  snapshot: BoardSnapshot | null,
  thread: { readonly environmentId: EnvironmentId; readonly threadId: ThreadId },
): ReadonlyArray<ThreadBoardTask> {
  if (snapshot?.status !== "ready") return [];
  return snapshot.board.columns.flatMap((column) =>
    column.issues
      .filter((issue) =>
        issue.threads.some(
          (link) =>
            link.environmentId === thread.environmentId && link.threadId === thread.threadId,
        ),
      )
      .map((issue) => ({ issue, state: column.state })),
  );
}
