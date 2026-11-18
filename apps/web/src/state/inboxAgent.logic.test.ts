import { ProjectId, RunId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  findInboxAgentShell,
  inboxAgentLockedProvider,
  inboxAgentStatus,
} from "./inboxAgent.logic";

const PROJECT = ProjectId.make("project-acme");
const shell = (id: string, fields: Record<string, unknown> = {}) =>
  ({
    id: ThreadId.make(id),
    projectId: PROJECT,
    lineage: {
      parentThreadId: null,
      relationshipToParent: null,
      rootThreadId: ThreadId.make(id),
      sideChat: true,
      inboxAgent: true,
    },
    createdAt: DateTime.makeUnsafe(1_000),
    activeRunId: null,
    activityRunStatus: null,
    pendingRuntimeRequest: null,
    openQuestionsAt: null,
    ...fields,
  }) as never;

describe("inboxAgent.logic", () => {
  it("finds the project's oldest Inbox shell and nothing else", () => {
    const threads = [
      shell("chat", {
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: "chat" },
      }),
      shell("other", { projectId: ProjectId.make("project-other") }),
      shell("newer", { createdAt: DateTime.makeUnsafe(2_000) }),
      shell("older"),
    ];
    expect(findInboxAgentShell(threads, PROJECT)).toMatchObject({ id: "older" });
    expect(findInboxAgentShell(threads.slice(0, 2), PROJECT)).toBeNull();
  });

  it("shows waiting over running, and idle without a run", () => {
    expect(inboxAgentStatus(null)).toBe("idle");
    expect(inboxAgentStatus(shell("a"))).toBe("idle");
    expect(inboxAgentStatus(shell("a", { activeRunId: RunId.make("run-1") }))).toBe("running");
    expect(
      inboxAgentStatus(
        shell("a", { activeRunId: RunId.make("run-1"), activityRunStatus: "waiting" }),
      ),
    ).toBe("waiting");
    expect(inboxAgentStatus(shell("a", { openQuestionsAt: DateTime.makeUnsafe(1) }))).toBe(
      "waiting",
    );
  });

  it("locks only the Inbox's model picker to Claude", () => {
    expect(inboxAgentLockedProvider(shell("a"))).toBe("claudeAgent");
    expect(inboxAgentLockedProvider({ lineage: {} })).toBeNull();
    expect(inboxAgentLockedProvider(null)).toBeNull();
  });
});
