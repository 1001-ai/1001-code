import { MessageId, ThreadId, type ThreadPullRequestLink } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  type MomentMessage,
  type MomentRun,
  type MomentToolItem,
  messageMoment,
  pullRequestMoments,
  removedPullRequestMomentIds,
  runMoment,
  runtimeRequestMoment,
  toolItemMoment,
  windowMoments,
} from "./projectMoments.logic.ts";

const threadId = ThreadId.make("thread:moments");
const card = "Two ways.\n\n> **Q1 · Ship it today?**\n>\n> - Yes\n> - No";

const message = (overrides: Partial<MomentMessage>): MomentMessage => ({
  id: MessageId.make("message:1"),
  threadId,
  role: "user",
  streaming: false,
  createdAt: "2026-11-17T10:00:00.000Z",
  updatedAt: "2026-11-17T10:00:05.000Z",
  text: "Add the export button",
  createdBy: "user",
  scheduledTaskId: null,
  senderThreadId: null,
  linkedSenderTitle: null,
  internal: false,
  notification: false,
  ...overrides,
});

describe("messageMoment", () => {
  it.each([
    ["a person's prompt", {}, "prompt", { kind: "user", title: null }],
    [
      "a scheduled task",
      { createdBy: "agent", scheduledTaskId: "task:1" },
      "prompt",
      {
        kind: "scheduled-task",
        title: null,
      },
    ],
    [
      "another thread's agent",
      { createdBy: "agent", senderThreadId: ThreadId.make("thread:other") },
      "agent-in",
      { kind: "agent", title: "Docs pass" },
    ],
    [
      "a linked environment's agent",
      { createdBy: "agent", linkedSenderTitle: "Release checks" },
      "agent-in",
      { kind: "linked-agent", title: "Release checks" },
    ],
  ] as const)("classifies %s", (_name, overrides, kind, sender) => {
    const moment = messageMoment(message(overrides), "Exports", "Docs pass");
    expect(moment).toMatchObject({ kind, sender, messageId: "message:1", threadTitle: "Exports" });
  });

  it.each([
    ["T3 Code's own messages", { internal: true }],
    ["wakes", { createdBy: "agent", notification: true }],
    ["agent messages with no sender", { createdBy: "agent" }],
  ] as const)("skips %s", (_name, overrides) => {
    expect(messageMoment(message(overrides), "Exports", null)).toBeNull();
  });

  it("asks a question only once the assistant message finished", () => {
    const asked = message({ role: "assistant", createdBy: "agent", text: card });
    expect(messageMoment({ ...asked, streaming: true }, "Exports", null)).toBeNull();
    expect(messageMoment(asked, "Exports", null)).toMatchObject({
      id: "question:message:1",
      kind: "question",
      at: "2026-11-17T10:00:05.000Z",
      snippet: "Ship it today?",
    });
    expect(messageMoment({ ...asked, text: "> **Q1 · Ship it?**" }, "Exports", null)).toBeNull();
  });
});

const run = (overrides: Partial<MomentRun>): MomentRun => ({
  runId: "run:1",
  threadId,
  status: "completed",
  completedAt: "2026-11-17T11:00:00.000Z",
  prompt: {
    notificationSourceKind: null,
    notificationSourceWork: null,
    notificationOutcome: null,
    delegatedCompletion: false,
    idleCompaction: false,
  },
  userSteered: false,
  lastAssistant: { id: MessageId.make("message:reply"), text: "Done, the tests pass." },
  ...overrides,
});
const wakePrompt = (outcome: string, kind = "command") => ({
  notificationSourceKind: kind,
  notificationSourceWork: null,
  notificationOutcome: outcome,
  delegatedCompletion: false,
  idleCompaction: false,
});

describe("runMoment", () => {
  it("anchors a finished run to its last reply", () => {
    expect(runMoment(run({}), "Exports")).toMatchObject({
      id: "done:run:1",
      kind: "done",
      messageId: "message:reply",
      snippet: "Done, the tests pass.",
    });
  });

  it.each([
    ["a running run", { status: "running", completedAt: null }],
    ["a progress wake", { prompt: wakePrompt("updated") }],
    ["a legacy background command wake", { prompt: wakePrompt("updated", "background_command") }],
    ["T3 Code's own compaction", { prompt: { ...wakePrompt("updated"), idleCompaction: true } }],
  ] as const)("skips %s", (_name, overrides) => {
    expect(runMoment(run(overrides), "Exports")).toBeNull();
  });

  it.each([
    ["a wake the user steered into", { prompt: wakePrompt("updated"), userSteered: true }],
    ["a wake reporting its end", { prompt: wakePrompt("completed") }],
  ] as const)("keeps %s", (_name, overrides) => {
    expect(runMoment(run(overrides), "Exports")?.kind).toBe("done");
  });
});

describe("runtimeRequestMoment", () => {
  const request = {
    id: "request:1",
    threadId,
    kind: "user_input",
    status: "pending",
    createdAt: "2026-11-17T12:00:00.000Z",
  };
  it("shows provider questions while they wait", () => {
    expect(runtimeRequestMoment(request, "Exports")).toMatchObject({
      id: "input:request:1",
      kind: "input-request",
    });
    expect(runtimeRequestMoment({ ...request, status: "resolved" }, "Exports")).toBeNull();
    expect(runtimeRequestMoment({ ...request, kind: "command" }, "Exports")).toBeNull();
  });
});

const link = (snapshot: Partial<NonNullable<ThreadPullRequestLink["snapshot"]>>) =>
  ({
    host: "github.com",
    repository: "acme/app",
    number: 12,
    url: "https://github.com/acme/app/pull/12",
    source: "agent",
    linkedAt: "2026-11-17T09:00:00.000Z",
    stack: null,
    snapshot: {
      state: "open",
      title: "feat: export button",
      headBranch: "feat/export",
      baseBranch: "main",
      isDraft: false,
      updatedAt: "2026-11-17T13:00:00.000Z",
      syncedAt: "2026-11-17T13:00:01.000Z",
      checksState: "pending",
      ...snapshot,
    },
  }) satisfies ThreadPullRequestLink;

describe("pullRequestMoments", () => {
  it("shows a pull request in testing until its checks settle", () => {
    const testing = pullRequestMoments(threadId, "Exports", [link({})]);
    expect(testing).toEqual([
      expect.objectContaining({
        id: "pr-testing:thread:moments:github.com/acme/app#12",
        kind: "pr-testing",
        at: "2026-11-17T13:00:00.000Z",
        pullRequest: {
          number: 12,
          url: "https://github.com/acme/app/pull/12",
          title: "feat: export button",
        },
      }),
    ]);
    const settled = pullRequestMoments(threadId, "Exports", [link({ checksState: "passing" })]);
    expect(settled).toEqual([]);
    expect(
      removedPullRequestMomentIds(new Set(testing.map((moment) => moment.id)), settled),
    ).toEqual(["pr-testing:thread:moments:github.com/acme/app#12"]);
  });

  it("shows a merge at its merge time", () => {
    const merged = pullRequestMoments(threadId, "Exports", [
      link({ state: "merged", mergedAt: "2026-11-17T15:00:00.000Z", checksState: "passing" }),
    ]);
    expect(merged).toEqual([
      expect.objectContaining({ kind: "pr-merged", at: "2026-11-17T15:00:00.000Z" }),
    ]);
  });
});

const sendItem = (toolName: string, input: unknown): MomentToolItem => ({
  id: "item:1",
  threadId,
  type: "dynamic_tool",
  status: "completed",
  toolName,
  input,
  updatedAt: "2026-11-17T14:00:00.000Z",
});
const label = (environmentId: string) => (environmentId === "env:peer" ? "Build box" : null);

describe("toolItemMoment", () => {
  it.each([
    ["Claude and Cursor", "mcp__t3-code__t3_thread_send"],
    ["Codex and ACP", "t3-code.t3_thread_send"],
    ["OpenCode", "t3-code_t3_thread_send"],
  ])("counts a send to a linked environment from %s", (_name, toolName) => {
    const moment = toolItemMoment(
      sendItem(toolName, { environmentId: "env:peer", threadId: "t", message: "Rebase please" }),
      "Exports",
      "env:self",
      label,
    );
    expect(moment).toMatchObject({
      id: "agent-out:item:1",
      kind: "agent-out",
      snippet: "Rebase please",
      sender: { kind: "linked-agent", title: "Build box" },
    });
  });

  it.each([
    ["a send in this environment", sendItem("t3-code.t3_thread_send", { message: "Hi" })],
    [
      "a send naming this environment",
      sendItem("t3-code.t3_thread_send", { environmentId: "env:self", message: "Hi" }),
    ],
    ["another tool", sendItem("t3-code.t3_thread_wait", { environmentId: "env:peer" })],
    [
      "a send still running",
      { ...sendItem("t3-code.t3_thread_send", { environmentId: "env:peer" }), status: "running" },
    ],
  ])("skips %s", (_name, item) => {
    expect(toolItemMoment(item, "Exports", "env:self", label)).toBeNull();
  });
});

describe("windowMoments", () => {
  it("keeps the newest moments in the window, oldest first", () => {
    const at = (minute: number) => `2026-11-17T10:0${minute}:00.000Z`;
    const moments = [3, 1, 2, 0].map((minute) => ({
      ...messageMoment(message({ id: MessageId.make(`message:${minute}`) }), "Exports", null)!,
      at: at(minute),
    }));
    const result = windowMoments(moments, Date.parse(at(1)), 2);
    expect(result.truncated).toBe(true);
    expect(result.moments.map((moment) => moment.at)).toEqual([at(2), at(3)]);
  });
});
