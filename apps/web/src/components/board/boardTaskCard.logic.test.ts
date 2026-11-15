import type { OrchestrationV2TurnItem } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { boardStatusGlyph, boardTaskChangeOf } from "./boardTaskCard.logic";

const boardTask = {
  kind: "created",
  identifier: "COD-106",
  title: "The Board shows people's full names",
  url: "https://linear.app/1001ai/issue/COD-106/slug",
  status: "In Progress",
  statusType: "started",
};

const toolItem = (output: unknown, status = "completed") =>
  ({
    type: "dynamic_tool",
    status,
    toolName: "mcp__claude_ai_Linear__save_issue",
    input: {},
    output,
  }) as OrchestrationV2TurnItem;

describe("boardTaskChangeOf", () => {
  it("reads the change the server put on the wire output", () => {
    expect(boardTaskChangeOf(toolItem({ boardTask }))).toEqual(boardTask);
  });

  it.each([
    ["no change", toolItem({ threadId: "t" })],
    ["no output", toolItem(undefined)],
    ["a malformed change", toolItem({ boardTask: { ...boardTask, kind: "deleted" } })],
    ["a change without an identifier", toolItem({ boardTask: { ...boardTask, identifier: "" } })],
    ["a failed call", toolItem({ isError: true, boardTask })],
    ["a call still running", toolItem({ boardTask }, "running")],
    [
      "another item type",
      { ...toolItem({ boardTask }), type: "web_search" } as OrchestrationV2TurnItem,
    ],
  ])("stays a tool row for %s", (_name, item) => {
    expect(boardTaskChangeOf(item)).toBeNull();
  });
});

describe("boardStatusGlyph", () => {
  it.each([
    ["backlog", "Backlog", "backlog"],
    ["unstarted", "Todo", "unstarted"],
    ["triage", "Triage", "unstarted"],
    [undefined, "Todo", "unstarted"],
    ["started", "In Progress", "started"],
    ["started", "In Review", "review"],
    ["completed", "Done", "completed"],
    ["canceled", "Duplicate", "canceled"],
  ])("%s %s shows %s", (type, name, glyph) => {
    expect(boardStatusGlyph(type, name)).toBe(glyph);
  });
});
