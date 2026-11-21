import { ProjectId, RunId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  findInboxThread,
  INBOX_COMPOSER_PLACEHOLDER,
  inboxAgentAllowedProviders,
  inboxAgentStatus,
  inboxComposerPlaceholder,
  withoutInboxThreads,
} from "./inboxAgent.logic";

const PROJECT = ProjectId.make("project-acme");
/** A shell the server made and named Inbox, as every client receives it. */
const shell = (id: string, fields: Record<string, unknown> = {}) =>
  ({
    id: ThreadId.make(id),
    projectId: PROJECT,
    title: "Inbox",
    createdBy: "system",
    creationSource: "server",
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: ThreadId.make(id) },
    createdAt: DateTime.makeUnsafe(1_000),
    activeRunId: null,
    activityRunStatus: null,
    pendingRuntimeRequest: null,
    openQuestionsAt: null,
    ...fields,
  }) as never;

describe("inboxAgent.logic", () => {
  it("finds the project's oldest thread the server made and named Inbox", () => {
    const threads = [
      shell("user-named", { createdBy: "user", creationSource: "web", createdAt: 0 }),
      shell("agent-named", { createdBy: "agent", creationSource: "mcp" }),
      shell("chat", { title: "Fix the toolbar" }),
      shell("other", { projectId: ProjectId.make("project-other") }),
      shell("newer", { createdAt: DateTime.makeUnsafe(2_000) }),
      shell("older"),
    ];
    expect(findInboxThread(threads, PROJECT)).toMatchObject({ id: "older" });
    expect(findInboxThread(threads.slice(0, 4), PROJECT)).toBeNull();
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

  it("restricts only the Inbox's model picker to supported locked-agent providers, and gives only it its placeholder", () => {
    expect(inboxAgentAllowedProviders({ source: shell("a") })).toEqual([
      "claudeAgent",
      "antigravity",
    ]);
    expect(inboxAgentAllowedProviders({ source: shell("a", { createdBy: "user" }) })).toBeNull();
    expect(inboxAgentAllowedProviders({})).toBeNull();
    expect(inboxAgentAllowedProviders(null)).toBeNull();
    expect(inboxComposerPlaceholder({ source: shell("a") }, "Ask anything")).toBe(
      INBOX_COMPOSER_PLACEHOLDER,
    );
    expect(inboxComposerPlaceholder(undefined, "Ask anything")).toBe("Ask anything");
  });

  it("leaves the Inbox out of the sidebar's thread list, keeping the list as it is otherwise", () => {
    const chat = { source: shell("chat", { title: "Fix the toolbar" }) };
    const inbox = { source: shell("inbox") };
    const withInbox = [chat, inbox];
    expect(withoutInboxThreads(withInbox)).toEqual([chat]);
    expect(withoutInboxThreads(withInbox)).toBe(withoutInboxThreads(withInbox));
    const plain = [chat];
    expect(withoutInboxThreads(plain)).toBe(plain);
  });
});
