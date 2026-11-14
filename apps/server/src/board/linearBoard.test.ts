import { describe, expect, it } from "@effect/vitest";

import { boardColumns, type LinearIssue, type LinearState, linearFailure } from "./linearBoard.ts";

const states: ReadonlyArray<LinearState> = [
  { id: "done", name: "Done", type: "completed", color: "#5e6ad2", position: 0 },
  { id: "review", name: "In Review", type: "started", color: "#0f783c", position: 2 },
  { id: "todo", name: "Todo", type: "unstarted", color: "#e2e2e2", position: 0 },
  { id: "doing", name: "In Progress", type: "started", color: "#f2c94c", position: 1 },
  { id: "backlog", name: "Backlog", type: "backlog", color: "#bec2c8", position: 0 },
  { id: "triage", name: "Triage", type: "triage", color: "#fc7840", position: 0 },
  { id: "canceled", name: "Canceled", type: "canceled", color: "#95a2b3", position: 0 },
];

const issue = (overrides: Partial<LinearIssue> & Pick<LinearIssue, "id">): LinearIssue => ({
  identifier: `ENG-${overrides.id}`,
  title: `Issue ${overrides.id}`,
  url: `https://linear.app/acme/issue/ENG-${overrides.id}`,
  updatedAt: "2026-11-14T10:00:00.000Z",
  sortOrder: 0,
  state: { id: "todo" },
  assignee: null,
  labels: { nodes: [] },
  attachments: { nodes: [] },
  ...overrides,
});

describe("boardColumns", () => {
  it("orders columns as Linear's board does and issues by their manual order", () => {
    const columns = boardColumns(states, [
      issue({ id: "1", state: { id: "doing" }, sortOrder: 20 }),
      issue({ id: "2", state: { id: "doing" }, sortOrder: -5 }),
      issue({ id: "3", state: { id: "done" } }),
      issue({ id: "4", state: { id: "unknown-state" } }),
    ]);
    expect(columns.map((column) => column.state.name)).toEqual([
      "Triage",
      "Backlog",
      "Todo",
      "In Progress",
      "In Review",
      "Done",
      "Canceled",
    ]);
    expect(columns[3]?.issues.map((entry) => entry.identifier)).toEqual(["ENG-2", "ENG-1"]);
    expect(columns[5]?.issues.map((entry) => entry.identifier)).toEqual(["ENG-3"]);
    expect(columns.flatMap((column) => column.issues)).toHaveLength(3);
  });

  it("maps assignees, labels, pull requests and thread links", () => {
    const [todo] = boardColumns(
      [states[2]!],
      [
        issue({
          id: "7",
          assignee: {
            id: "u1",
            name: "Dana Kim",
            displayName: "dana",
            avatarUrl: null,
            isMe: true,
          },
          labels: { nodes: [{ id: "l1", name: "Bug", color: "#eb5757" }] },
          attachments: {
            nodes: [
              {
                url: "https://github.com/acme/web/pull/42",
                sourceType: "github",
                metadata: { status: "merged", number: 42 },
              },
              { url: "https://github.com/acme/web/issues/9", sourceType: "github", metadata: {} },
              { url: "https://example.com/acme/web/pull/3", sourceType: null, metadata: null },
              {
                url: "https://app.t3.codes/threads/env-1/thread-9",
                sourceType: "api",
                metadata: {},
              },
            ],
          },
        }),
      ],
    );
    expect(todo?.issues[0]).toEqual({
      id: "7",
      identifier: "ENG-7",
      title: "Issue 7",
      url: "https://linear.app/acme/issue/ENG-7",
      stateId: "todo",
      assignee: { id: "u1", name: "dana", avatarUrl: null, isMe: true },
      labels: [{ id: "l1", name: "Bug", color: "#eb5757" }],
      updatedAt: "2026-11-14T10:00:00.000Z",
      pullRequests: [
        {
          url: "https://github.com/acme/web/pull/42",
          host: "github.com",
          repository: "acme/web",
          number: 42,
          linearStatus: "merged",
        },
      ],
      thread: { environmentId: "env-1", threadId: "thread-9" },
    });
  });
});

describe("linearFailure", () => {
  it.each([
    ["data without errors", 200, { data: { viewer: {} } }, undefined, null],
    ["HTTP 429", 429, { errors: [] }, "120", { reason: "rate-limited", retryAfterSeconds: 120 }],
    [
      "a RATELIMITED error",
      400,
      { errors: [{ message: "Rate limit exceeded", extensions: { code: "RATELIMITED" } }] },
      undefined,
      { reason: "rate-limited" },
    ],
    [
      "an authentication error",
      400,
      {
        errors: [
          {
            message: "Authentication required, not authenticated",
            extensions: { type: "authentication error", code: "AUTHENTICATION_ERROR" },
          },
        ],
      },
      undefined,
      { reason: "unauthorized" },
    ],
    ["HTTP 401", 401, null, undefined, { reason: "unauthorized" }],
    ["HTTP 503", 503, null, undefined, { reason: "unreachable" }],
    [
      "a query error",
      400,
      { errors: [{ message: "Field 'x' does not exist" }] },
      undefined,
      {
        reason: "invalid-response",
        detail: "Linear refused the request: Field 'x' does not exist",
      },
    ],
  ] as const)("classifies %s", (_name, status, body, retryAfter, expected) => {
    const failure = linearFailure({ status, body, retryAfter });
    if (expected === null) {
      expect(failure).toBeNull();
    } else {
      expect(failure).toMatchObject(expected);
    }
  });

  it("leaves out a retry delay Linear did not give", () => {
    expect(linearFailure({ status: 429, body: null, retryAfter: "soon" })).not.toHaveProperty(
      "retryAfterSeconds",
    );
  });
});
