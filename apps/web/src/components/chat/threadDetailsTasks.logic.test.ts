import {
  type BoardIssue,
  type BoardSnapshot,
  type BoardWorkflowState,
  EnvironmentId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { threadBoardTasks } from "./threadDetailsTasks.logic";

const thread = { environmentId: EnvironmentId.make("env-1"), threadId: ThreadId.make("thread-1") };

const link = (environmentId: string, threadId: string) => ({
  environmentId: EnvironmentId.make(environmentId),
  threadId: ThreadId.make(threadId),
  linkedAt: "2026-11-14T10:00:00.000Z",
  linkedBy: null,
});

const issue = (id: string, threads: BoardIssue["threads"]): BoardIssue => ({
  id,
  identifier: `COD-${id}`,
  title: id,
  url: `https://linear.app/acme/issue/COD-${id}`,
  stateId: "state",
  assignee: null,
  labels: [],
  priority: 0,
  createdAt: "2026-11-13T10:00:00.000Z",
  startedAt: null,
  updatedAt: "2026-11-14T10:00:00.000Z",
  pullRequests: [],
  threads,
});

const state = (id: string, type: string): BoardWorkflowState => ({
  id,
  name: id,
  type,
  color: "#000",
});

const ready = (columns: Extract<BoardSnapshot, { status: "ready" }>["board"]["columns"]) =>
  ({
    status: "ready",
    failure: null,
    board: {
      team: { id: "team", key: "COD", name: "Code" },
      project: null,
      columns,
      truncated: false,
      fetchedAt: "2026-11-14T10:00:00.000Z",
    },
  }) satisfies BoardSnapshot;

describe("threadBoardTasks", () => {
  it("keeps the issues linking this thread on this environment, with their column's state", () => {
    const started = state("In Progress", "started");
    const done = state("Done", "completed");
    const snapshot = ready([
      {
        state: started,
        issues: [
          issue("1", [link("env-2", "other"), link("env-1", "thread-1")]),
          issue("2", [link("env-2", "thread-1")]),
          issue("3", []),
        ],
      },
      { state: done, issues: [issue("4", [link("env-1", "thread-1")])] },
    ]);
    expect(
      threadBoardTasks(snapshot, thread).map((task) => [task.issue.identifier, task.state.name]),
    ).toEqual([
      ["COD-1", "In Progress"],
      ["COD-4", "Done"],
    ]);
  });

  it.each<BoardSnapshot | null>([
    null,
    { status: "not-connected" },
    { status: "unconfigured", reason: "no-linear-team", catalogFile: null },
    { status: "failed", failure: { reason: "unreachable", detail: "offline" } },
  ])("has no tasks without a ready board: %o", (snapshot) => {
    expect(threadBoardTasks(snapshot, thread)).toEqual([]);
  });
});
