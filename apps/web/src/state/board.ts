import { useAtomValue } from "@effect/atom-react";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import {
  type BoardConnection,
  type BoardIssueDetail,
  type BoardSnapshot,
  type EnvironmentId,
  type ProjectId,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { AsyncResult, Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";

// The server reads Linear when a board subscribes or refreshes; an idle board stops listening.
const boardSubscription = createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
  label: "environment-data:board",
  tag: WS_METHODS.boardSubscribe,
  idleTtlMs: 30_000,
});

const boardConnectionSubscription = createEnvironmentRpcSubscriptionAtomFamily(
  connectionAtomRuntime,
  {
    label: "environment-data:board:connection",
    tag: WS_METHODS.boardSubscribeConnection,
    idleTtlMs: 60_000,
  },
);

export const boardRefresh = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:board:refresh",
  tag: WS_METHODS.boardRefresh,
});

// The issue's updatedAt on the open board; a description edit advances it, so a change re-reads.
const boardIssueUpdatedAt = Atom.family((key: string) => {
  const [environmentId, projectId, issueId] = JSON.parse(key) as [EnvironmentId, ProjectId, string];
  let updatedAt: string | null = null;
  return Atom.make((get) => {
    const snapshot = AsyncResult.getOrElse(
      get(boardSubscription({ environmentId, input: { projectId } })),
      () => null,
    );
    if (snapshot?.status !== "ready") return updatedAt;
    for (const column of snapshot.board.columns) {
      const issue = column.issues.find((entry) => entry.id === issueId);
      if (issue !== undefined) updatedAt = issue.updatedAt;
    }
    return updatedAt;
  }).pipe(Atom.setIdleTTL(0), Atom.withLabel(`web-board-issue-updated-at:${key}`));
});

const boardIssueDetailQuery = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:board:issue-detail",
  tag: WS_METHODS.boardIssueDetail,
  idleTtlMs: 60_000,
  refreshTrigger: ({ environmentId, input }) =>
    boardIssueUpdatedAt(JSON.stringify([environmentId, input.projectId, input.issueId])),
});

/** Posts a comment on the issue and re-reads its detail, so the comment shows. */
export const boardComment = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:board:comment",
  tag: WS_METHODS.boardComment,
  onSuccess: ({ environmentId, input }, registry) =>
    Effect.sync(() =>
      registry.refresh(
        boardIssueDetailQuery({
          environmentId,
          input: { projectId: input.projectId, issueId: input.issueId },
        }),
      ),
    ),
});

export const boardConnect = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:board:connect",
  tag: WS_METHODS.boardConnect,
});

export const boardDisconnect = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:board:disconnect",
  tag: WS_METHODS.boardDisconnect,
});

const EMPTY_BOARD_ATOM = Atom.make(AsyncResult.initial<BoardSnapshot, never>()).pipe(
  Atom.withLabel("web-board:empty"),
);

const EMPTY_ISSUE_DETAIL_ATOM = Atom.make(AsyncResult.initial<BoardIssueDetail, never>()).pipe(
  Atom.withLabel("web-board-issue-detail:empty"),
);

/** An issue's description, creator and comments, read from Linear while the issue is open. */
export function useBoardIssueDetail(
  environmentId: EnvironmentId,
  projectId: ProjectId | null,
  issueId: string | null,
) {
  return useAtomValue(
    projectId === null || issueId === null
      ? EMPTY_ISSUE_DETAIL_ATOM
      : boardIssueDetailQuery({ environmentId, input: { projectId, issueId } }),
  );
}

/** The project's board; null until the server answers. */
export function useBoard(
  environmentId: EnvironmentId,
  projectId: ProjectId | null,
): BoardSnapshot | null {
  const result = useAtomValue(
    projectId === null
      ? EMPTY_BOARD_ATOM
      : boardSubscription({ environmentId, input: { projectId } }),
  );
  return AsyncResult.getOrElse(result, () => null);
}

/** Who the environment reads Linear as; null until the server answers. */
export function useBoardConnection(environmentId: EnvironmentId): BoardConnection | null {
  const result = useAtomValue(boardConnectionSubscription({ environmentId, input: {} }));
  return AsyncResult.getOrElse(result, () => null);
}
