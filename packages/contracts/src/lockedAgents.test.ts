import { describe, expect, it } from "vite-plus/test";

import {
  INBOX_AGENT_DEFAULT_MODEL,
  inboxAgentDefaultModel,
  inboxAgentDigestOf,
  isInboxThreadShell,
} from "./inboxAgent.ts";
import {
  LOCKED_AGENT_DRIVERS,
  LOCKED_AGENT_TOOL_NAMES,
  lockedAgentDriverAllowed,
  lockedAgentToolAllowed,
} from "./lockedAgents.ts";
import { ANTIGRAVITY_DEFAULT_MODEL } from "./model.ts";
import { ProviderDriverKind } from "./providerInstance.ts";

describe("lockedAgents", () => {
  it("knows a project's Inbox only by the server's name for it, made by the server", () => {
    const lineage = { parentThreadId: null, relationshipToParent: null, rootThreadId: "t" };
    const inbox = {
      title: "Inbox",
      createdBy: "system",
      creationSource: "server",
      lineage,
    } as const;
    expect(isInboxThreadShell(inbox as never)).toBe(true);
    expect(
      isInboxThreadShell({ ...inbox, createdBy: "user", creationSource: "web" } as never),
    ).toBe(false);
    expect(
      isInboxThreadShell({ ...inbox, createdBy: "agent", creationSource: "mcp" } as never),
    ).toBe(false);
    expect(isInboxThreadShell({ ...inbox, title: "Inbox 2" } as never)).toBe(false);
    expect(
      isInboxThreadShell({ ...inbox, lineage: { ...lineage, parentThreadId: "chat" } } as never),
    ).toBe(false);
    expect(isInboxThreadShell({ ...inbox, lineage: { ...lineage, sideChat: true } } as never)).toBe(
      false,
    );
    expect(isInboxThreadShell(null)).toBe(false);
  });

  it.each([
    ["t3_thread_read", "inbox", true],
    ["board_list", "inbox", true],
    ["memory_propose", "inbox", true],
    ["memory_withdraw", "inbox", true],
    ["memory_withdraw", "voice", true],
    ["t3_thread_send", "inbox", true],
    ["t3_thread_launch", "inbox", true],
    ["orchestrator_capabilities", "inbox", true],
    ["delegate_task", "inbox", false],
    ["t3_thread_interrupt", "inbox", false],
    ["voice_board", "inbox", false],
    ["voice_board", "voice", true],
    ["t3_thread_read", "voice", false],
    ["voice_board", null, false],
    ["t3_thread_send", null, true],
    ["inbox_forward", "inbox", true],
    ["inbox_forward", null, false],
    ["inbox_forward", "voice", false],
    ["board_message", null, true],
    ["board_message", "inbox", false],
  ] as const)("lets %s through for %s: %s", (tool, kind, allowed) => {
    expect(lockedAgentToolAllowed(tool, kind)).toBe(allowed);
  });

  it("gives the Inbox exactly its read tools, the ones to message and start threads and the forward", () => {
    expect(LOCKED_AGENT_TOOL_NAMES.inbox).toEqual([
      "t3_thread_list",
      "t3_thread_read",
      "t3_thread_search",
      "t3_thread_send",
      "t3_thread_wait",
      "t3_thread_launch",
      "orchestrator_capabilities",
      "board_list",
      "memory_propose",
      "memory_withdraw",
      "inbox_forward",
    ]);
  });

  it("allows Claude and Antigravity for the Inbox, and Claude only for the voice agent", () => {
    expect(LOCKED_AGENT_DRIVERS.inbox).toEqual(["claudeAgent", "antigravity"]);
    expect(LOCKED_AGENT_DRIVERS.voice).toEqual(["claudeAgent"]);
    expect(lockedAgentDriverAllowed(ProviderDriverKind.make("claudeAgent"), "inbox")).toBe(true);
    expect(lockedAgentDriverAllowed(ProviderDriverKind.make("antigravity"), "inbox")).toBe(true);
    expect(lockedAgentDriverAllowed(ProviderDriverKind.make("codex"), "inbox")).toBe(false);
    expect(lockedAgentDriverAllowed(ProviderDriverKind.make("claudeAgent"), "voice")).toBe(true);
    expect(lockedAgentDriverAllowed(ProviderDriverKind.make("antigravity"), "voice")).toBe(false);
    expect(inboxAgentDefaultModel(ProviderDriverKind.make("claudeAgent"))).toBe(
      INBOX_AGENT_DEFAULT_MODEL,
    );
    expect(inboxAgentDefaultModel(ProviderDriverKind.make("antigravity"))).toBe(
      ANTIGRAVITY_DEFAULT_MODEL,
    );
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
