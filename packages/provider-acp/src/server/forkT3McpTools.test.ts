import { describe, expect, it } from "vite-plus/test";

import { extractMcpToolCallIdentity, parseSessionUpdateEvent } from "./runtimeModel.ts";

const toolCallFromTitle = (title: string) => {
  const parsed = parseSessionUpdateEvent({
    sessionId: "session-1",
    update: { sessionUpdate: "tool_call", toolCallId: "fork-1", kind: "other", title },
  });
  const event = parsed.events.find((candidate) => candidate._tag === "ToolCallUpdated");
  if (event?._tag !== "ToolCallUpdated") throw new Error("expected a tool call event");
  return event.toolCall;
};

describe("extractMcpToolCallIdentity with the fork's T3 tools", () => {
  it.each([
    ["Running board_add", "board_add"],
    ['board_update: {"task":"ENG-115","status":"Done"}', "board_update"],
    ["@t3-code/board_list", "board_list"],
    ["t3-code/memory_propose", "memory_propose"],
  ])("names a title-only %s call as T3's", (title, tool) => {
    expect(extractMcpToolCallIdentity(toolCallFromTitle(title))).toEqual({
      server: "t3-code",
      tool,
    });
  });
});
