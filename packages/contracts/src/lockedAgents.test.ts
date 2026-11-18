import { describe, expect, it } from "vite-plus/test";

import { inboxAgentDigestOf } from "./inboxAgent.ts";
import {
  LOCKED_AGENT_TOOL_NAMES,
  lockedAgentKind,
  lockedAgentToolAllowed,
} from "./lockedAgents.ts";

describe("lockedAgents", () => {
  it("reads a thread's kind from its lineage", () => {
    expect(lockedAgentKind({ voiceAgent: true })).toBe("voice");
    expect(lockedAgentKind({ inboxAgent: true })).toBe("inbox");
    expect(lockedAgentKind({})).toBeNull();
  });

  it.each([
    ["t3_thread_read", "inbox", true],
    ["board_list", "inbox", true],
    ["memory_propose", "inbox", true],
    ["t3_thread_send", "inbox", false],
    ["voice_board", "inbox", false],
    ["voice_board", "voice", true],
    ["t3_thread_read", "voice", false],
    ["voice_board", null, false],
    ["t3_thread_send", null, true],
  ] as const)("lets %s through for %s: %s", (tool, kind, allowed) => {
    expect(lockedAgentToolAllowed(tool, kind)).toBe(allowed);
  });

  it("gives the Inbox exactly its five read tools", () => {
    expect(LOCKED_AGENT_TOOL_NAMES.inbox).toEqual([
      "t3_thread_list",
      "t3_thread_read",
      "t3_thread_search",
      "board_list",
      "memory_propose",
    ]);
  });

  it("reads the digest a message carries, and nothing from a record that is not one", () => {
    const digest = {
      since: "2026-11-17T10:00:00.000Z",
      until: "2026-11-18T10:00:00.000Z",
      entries: [
        {
          kind: "run-failed",
          threadId: "thread-1",
          title: "Migrations",
          at: "2026-11-18T09:00:00.000Z",
          detail: "Tests failed.",
        },
      ],
      omitted: 0,
    };
    const record = (payload: unknown) => ({
      version: 1 as const,
      records: [
        {
          version: 1,
          contextId: "inbox-digest",
          label: "What changed",
          kind: "inbox-digest",
          payload,
        },
      ] as never,
    });
    expect(inboxAgentDigestOf(record(digest))).toEqual(digest);
    expect(inboxAgentDigestOf(record({ since: 1 }))).toBeNull();
    expect(inboxAgentDigestOf(undefined)).toBeNull();
  });
});
