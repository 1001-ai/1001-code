import { type BoardColumn, type BoardIssue, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { boardIssueTarget, boardPullRequestStatus, filterBoardColumns } from "./board.logic";

const issue = (id: string, isMe: boolean | null): BoardIssue => ({
  id,
  identifier: `ENG-${id}`,
  title: id,
  url: `https://linear.app/acme/issue/ENG-${id}`,
  stateId: "todo",
  assignee: isMe === null ? null : { id: "u", name: "Dana", avatarUrl: null, isMe },
  labels: [],
  updatedAt: "2026-11-14T10:00:00.000Z",
  pullRequests: [],
  thread: null,
});

const column: BoardColumn = {
  state: { id: "todo", name: "Todo", type: "unstarted", color: "#000" },
  issues: [issue("1", true), issue("2", false), issue("3", null)],
};

describe("filterBoardColumns", () => {
  it("keeps every column and only my issues under mine", () => {
    expect(filterBoardColumns([column], "all")).toEqual([column]);
    expect(
      filterBoardColumns([column], "mine").map((entry) => entry.issues.map((item) => item.id)),
    ).toEqual([["1"]]);
  });
});

describe("boardIssueTarget", () => {
  const environmentId = EnvironmentId.make("env-1");
  const linked = {
    ...issue("4", null),
    thread: { environmentId, threadId: ThreadId.make("thread-1") },
  };

  it("opens a linked thread on a connected environment, else the issue in Linear", () => {
    expect(boardIssueTarget(linked, new Set([environmentId]))).toEqual({
      kind: "thread",
      ref: { environmentId, threadId: "thread-1" },
    });
    expect(boardIssueTarget(linked, new Set())).toEqual({ kind: "linear", url: linked.url });
    expect(boardIssueTarget(issue("5", null), new Set([environmentId]))).toEqual({
      kind: "linear",
      url: "https://linear.app/acme/issue/ENG-5",
    });
  });
});

describe("boardPullRequestStatus", () => {
  it("prefers T3 Code's own synced state over Linear's", () => {
    expect(
      boardPullRequestStatus(
        {
          state: "open",
          title: "Fix",
          headBranch: "fix",
          baseBranch: "main",
          isDraft: false,
          updatedAt: null,
          syncedAt: "2026-11-14T10:00:00.000Z",
          checksState: "failing",
          reviewDecision: "approved",
        },
        "merged",
      ),
    ).toEqual({
      state: "open",
      isDraft: false,
      checksState: "failing",
      reviewDecision: "approved",
    });
  });

  it("falls back to Linear's recorded status, and to nothing it does not know", () => {
    expect(boardPullRequestStatus(null, "Draft")).toMatchObject({ state: "open", isDraft: true });
    expect(boardPullRequestStatus(undefined, "merged")).toMatchObject({ state: "merged" });
    expect(boardPullRequestStatus(null, "something-new")).toBeNull();
    expect(boardPullRequestStatus(null, null)).toBeNull();
  });
});
