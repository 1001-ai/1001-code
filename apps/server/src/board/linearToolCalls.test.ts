import { RunId, ThreadId, TurnItemId, type OrchestrationV2TurnItem } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import { projectTurnItemForWire } from "../orchestration-v2/WireProjection.ts";
import { boardTaskChange, isLinearWriteToolName, linearWriteTool } from "./linearToolCalls.ts";

describe("isLinearWriteToolName", () => {
  it.each([
    // Claude, and Cursor's `mcp__<provider>__<tool>`.
    "mcp__claude_ai_Linear__save_issue",
    "mcp__linear__create_comment",
    "mcp__plugin_linear_linear__update_issue",
    "mcp__claude_ai_Linear__delete_attachment",
    "mcp__claude_ai_Linear__unshare_issue",
    // Codex and ACP agents' `<server>.<tool>`.
    "linear.save_issue",
    "Linear.create_issue",
    // OpenCode's `<server>_<tool>`.
    "linear_save_issue",
    "linear_mcp_merge_diff",
    // Codex's apps connector.
    "codex_apps.linear_save_issue",
  ])("%s writes", (name) => {
    expect(isLinearWriteToolName(name)).toBe(true);
  });

  it.each([
    "mcp__claude_ai_Linear__list_issues",
    "mcp__claude_ai_Linear__get_issue",
    "mcp__claude_ai_Linear__get_status_updates",
    "mcp__claude_ai_Linear__search_documentation",
    "mcp__claude_ai_Linear__extract_images",
    "mcp__claude_ai_Linear__prepare_file_upload",
    "mcp__claude_ai_Linear__whoami",
    "linear.list_comments",
    "linear_get_issue_status",
    "codex_apps.linear_list_issues",
    // Writes, but not to Linear.
    "mcp__claude_ai_Notion__notion-update-page",
    "mcp__github__create_issue",
    "github.create_pull_request",
    "jira_create_issue",
    "Bash",
    "",
    null,
  ])("%s does not", (name) => {
    expect(isLinearWriteToolName(name)).toBe(false);
  });

  it.each([
    "mcp__claude_ai_Linear__save_issue",
    "mcp__plugin_linear_linear__save_issue",
    "linear.save_issue",
    "Linear.save_issue",
    "linear_save_issue",
    "codex_apps.linear_save_issue",
  ])("%s is save_issue", (name) => {
    expect(linearWriteTool(name)).toBe("save_issue");
  });
});

const threadId = ThreadId.make("thread-1");
const at = DateTime.makeUnsafe("2026-11-15T10:00:00.000Z");

const createdResult = {
  id: "ENG-106",
  uuid: "4981c0de",
  title: "Search results keep their scroll position",
  url: "https://linear.app/acme/issue/ENG-106/search-results-keep-their-scroll-position",
  status: "In Progress",
  statusType: "started",
  assignee: "Alex Kim",
  assigneeId: "a575",
  project: "Code",
  team: "Code",
  createdBy: "Alex Kim",
  labels: [],
};

const boardResult = {
  task: {
    identifier: "ENG-115",
    title: "Settings show the current version",
    url: "https://linear.app/acme/issue/ENG-115/settings-show-the-current-version",
    status: { name: "Todo", type: "unstarted" },
    assignee: null,
    project: "Code",
  },
  threadLinked: true,
};

/** Claude's MCP result: text blocks holding Linear's JSON. */
const textBlocks = (value: unknown) => [{ type: "text", text: JSON.stringify(value) }];

const toolItem = (
  input: unknown,
  output: unknown,
  overrides: Partial<{ toolName: string; status: OrchestrationV2TurnItem["status"] }> = {},
): OrchestrationV2TurnItem => ({
  id: TurnItemId.make("item-1"),
  threadId,
  runId: RunId.make("run-1"),
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 1,
  status: overrides.status ?? "completed",
  title: null,
  startedAt: at,
  completedAt: at,
  updatedAt: at,
  type: "dynamic_tool",
  toolName: overrides.toolName ?? "mcp__claude_ai_Linear__save_issue",
  input,
  output,
});

describe("boardTaskChange", () => {
  it("files a task when the call has no id", () => {
    expect(
      boardTaskChange(toolItem({ team: "Code", title: "A" }, textBlocks(createdResult))),
    ).toEqual({
      kind: "created",
      identifier: "ENG-106",
      title: "Search results keep their scroll position",
      url: "https://linear.app/acme/issue/ENG-106/search-results-keep-their-scroll-position",
      status: "In Progress",
      statusType: "started",
      assignee: "Alex Kim",
      assigneeId: "a575",
      project: "Code",
    });
  });

  it.each([
    ["picked_up", { id: "ENG-106", assignee: "me" }],
    ["picked_up", { id: "ENG-106", assignee: "me", state: "In Progress" }],
    ["status", { id: "ENG-106", state: "In Review" }],
    ["status", { id: "ENG-106", assignee: null, state: "Todo" }],
    ["status", { server: "linear", tool: "save_issue", arguments: { id: "ENG-1", state: "Done" } }],
    ["created", { tool_id: "linear::save_issue", arguments: { team: "Code", title: "A" } }],
    [undefined, { id: "ENG-106", description: "New text" }],
    [undefined, { id: "ENG-106", labels: ["Bug"] }],
  ])("classifies an update as %s", (kind, input) => {
    expect(boardTaskChange(toolItem(input, textBlocks(createdResult)))?.kind).toBe(kind);
  });

  it("reads each provider's result shape and tolerates missing optional fields", () => {
    const { statusType: _type, assignee: _assignee, project: _project, ...bare } = createdResult;
    // Codex keeps `structuredContent`, Grok wraps the text as `OkayOutput`.
    for (const output of [
      { structuredContent: bare },
      { type: "MCP", output: { OkayOutput: JSON.stringify(bare) } },
      JSON.stringify(bare),
    ]) {
      expect(
        boardTaskChange(
          toolItem({ id: "ENG-106", state: "Done" }, output, { toolName: "linear.save_issue" }),
        ),
      ).toMatchObject({ kind: "status", identifier: "ENG-106", status: "In Progress" });
    }
  });

  it.each([
    ["a failed call", toolItem({ title: "A" }, textBlocks(createdResult), { status: "failed" })],
    ["a running call", toolItem({ title: "A" }, undefined, { status: "running" })],
    [
      "an error result",
      toolItem({ title: "A" }, { isError: true, content: textBlocks(createdResult) }),
    ],
    ["a plain text result", toolItem({ title: "A" }, [{ type: "text", text: "Issue created" }])],
    [
      "a result without a title",
      toolItem({ title: "A" }, textBlocks({ ...createdResult, title: 7 })),
    ],
    [
      "a uuid as the id",
      toolItem({ title: "A" }, textBlocks({ ...createdResult, id: "4981c0de-aa" })),
    ],
    ["no result", toolItem({ title: "A" }, undefined)],
    [
      "another Linear call",
      toolItem({ body: "Hi" }, textBlocks(createdResult), {
        toolName: "mcp__claude_ai_Linear__save_comment",
      }),
    ],
    [
      "a Linear read",
      toolItem({ id: "ENG-106" }, textBlocks(createdResult), {
        toolName: "mcp__claude_ai_Linear__get_issue",
      }),
    ],
    [
      "another server's save_issue",
      toolItem({ title: "A" }, textBlocks(createdResult), { toolName: "mcp__jira__save_issue" }),
    ],
    [
      "a non-Linear tool",
      toolItem({ command: "ls" }, textBlocks(createdResult), { toolName: "Bash" }),
    ],
  ])("leaves %s as a tool row", (_name, item) => {
    expect(boardTaskChange(item)).toBeUndefined();
  });

  it.each([
    "mcp__t3-code__board_add",
    "mcp__t3_code__board_add",
    "t3-code.board_add",
    "t3-code-direct.board_add",
    "t3-code_board_add",
    "t3-code-thread_opencode2-adapter_board_add",
  ])("files a task with T3's %s", (toolName) => {
    expect(
      boardTaskChange(toolItem({ title: "A" }, textBlocks(boardResult), { toolName })),
    ).toEqual({
      kind: "created",
      identifier: "ENG-115",
      title: "Settings show the current version",
      url: "https://linear.app/acme/issue/ENG-115/settings-show-the-current-version",
      status: "Todo",
      statusType: "unstarted",
      project: "Code",
    });
  });

  it.each([
    ["picked_up", { task: "ENG-115", assignee: "me" }],
    ["picked_up", { task: "ENG-115", assignee: "me", status: "In Progress" }],
    ["status", { task: "ENG-115", status: "In Review" }],
    [
      "status",
      { server: "t3-code", tool: "board_update", arguments: { task: "ENG-1", status: "Done" } },
    ],
    [undefined, { task: "ENG-115", title: "New title" }],
  ])("classifies a board_update as %s", (kind, input) => {
    const assigned = { ...boardResult, task: { ...boardResult.task, assignee: "Alex Kim" } };
    // Codex keeps T3's whole result: `structuredContent` beside the text block.
    const output = { isError: false, structuredContent: assigned, content: textBlocks(assigned) };
    expect(
      boardTaskChange(toolItem(input, output, { toolName: "t3-code.board_update" }))?.kind,
    ).toBe(kind);
  });

  it.each([
    [
      "board_list",
      toolItem({}, textBlocks({ tasks: [boardResult.task], truncated: false }), {
        toolName: "mcp__t3-code__board_list",
      }),
    ],
    [
      "a failed board_update",
      toolItem({ task: "ENG-115", status: "Done" }, textBlocks(boardResult), {
        toolName: "mcp__t3-code__board_update",
        status: "failed",
      }),
    ],
    [
      "a board_update error result",
      toolItem(
        { task: "ENG-115", status: "Done" },
        { isError: true, content: [{ type: "text", text: "Unknown status Done" }] },
        { toolName: "t3-code.board_update" },
      ),
    ],
    [
      "another server's board_add",
      toolItem({ title: "A" }, textBlocks(boardResult), { toolName: "mcp__other__board_add" }),
    ],
    [
      "a Linear issue as board_add's result",
      toolItem({ title: "A" }, textBlocks(createdResult), { toolName: "t3-code.board_add" }),
    ],
  ])("leaves %s as a tool row", (_name, item) => {
    expect(boardTaskChange(item)).toBeUndefined();
  });

  it("rides the wire output beside the compact fields", () => {
    const projected = projectTurnItemForWire(toolItem({ title: "A" }, textBlocks(createdResult)));
    expect(projected.type === "dynamic_tool" && projected.output).toMatchObject({
      boardTask: { kind: "created", identifier: "ENG-106" },
    });
    const other = projectTurnItemForWire(
      toolItem({ id: "ENG-106", description: "x" }, textBlocks(createdResult)),
    );
    expect(other.type === "dynamic_tool" && other.output).toBeUndefined();
  });
});
