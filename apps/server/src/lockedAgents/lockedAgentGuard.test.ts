import { ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";

import { recordInboxThread } from "../inboxAgent/inboxAgentThreads.ts";
import { liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import { voiceAgentThread } from "../voiceAgent/voiceAgentThread.ts";
import { lockedAgentMessage, lockedAgentRefusal } from "./lockedAgentGuard.ts";

const claude = ProviderInstanceId.make("claudeAgent");
const onClaude = (thread: ReturnType<typeof liveThreadShell>, title = "A chat") => ({
  ...thread,
  title,
  providerInstanceId: claude,
});
const chat = onClaude(liveThreadShell(ThreadId.make("chat")));
// An ordinary thread named Inbox: only the server's record makes it the Inbox.
const inbox = onClaude(liveThreadShell(ThreadId.make("inbox")), "Inbox");
recordInboxThread(ProjectId.make("project-acme"), inbox.id);
const voice = {
  ...onClaude(liveThreadShell(ThreadId.make("voice"))),
  ...voiceAgentThread(onClaude(liveThreadShell(ThreadId.make("voice"))) as never, chat.id, chat),
};

const toCodex = {
  type: "thread.model-selection.set",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
};

it.each([
  ["inbox", inbox],
  ["voice", voice],
])("keeps a %s thread on its provider and title, with any model of it", (_kind, thread) => {
  expect(lockedAgentRefusal(toCodex, thread)).toContain("cannot change");
  expect(
    lockedAgentRefusal(
      {
        type: "message.dispatch",
        modelSelection: { instanceId: claude, model: "claude-opus-5-5" },
      },
      thread,
    ),
  ).toBeNull();
  expect(lockedAgentRefusal({ type: "thread.runtime-mode.set" }, thread)).toBeNull();
  expect(lockedAgentMessage({ text: "hi", titleSeed: "Rename me" }, thread)).toEqual({
    text: "hi",
  });
});

it("keeps the Inbox's name, which is how every app finds it", () => {
  const rename = (fields: object) =>
    lockedAgentRefusal({ type: "thread.metadata.update", ...fields }, inbox);
  expect(rename({ title: "My inbox" })).toContain("keeps its name");
  expect(rename({ regenerateTitle: true })).toContain("keeps its name");
  expect(rename({ title: "Inbox" })).toBeNull();
  expect(rename({ branch: null })).toBeNull();
  // The voice agent's thread may be renamed, as before.
  expect(lockedAgentRefusal({ type: "thread.metadata.update", title: "Talk" }, voice)).toBeNull();
});

it("leaves every other thread's commands alone", () => {
  expect(lockedAgentRefusal(toCodex, chat)).toBeNull();
  expect(lockedAgentRefusal({ type: "thread.metadata.update", title: "Inbox" }, chat)).toBeNull();
  const command = { text: "hi", titleSeed: "A title" };
  expect(lockedAgentMessage(command, chat)).toBe(command);
});
