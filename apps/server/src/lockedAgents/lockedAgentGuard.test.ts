import { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";

import { inboxAgentThread } from "../inboxAgent/inboxAgentThread.ts";
import { liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import { voiceAgentThread } from "../voiceAgent/voiceAgentThread.ts";
import { lockedAgentMessage, lockedAgentRefusesProvider } from "./lockedAgentGuard.ts";

const claude = ProviderInstanceId.make("claudeAgent");
const onClaude = (thread: ReturnType<typeof liveThreadShell>) => ({
  ...thread,
  providerInstanceId: claude,
});
const chat = onClaude(liveThreadShell(ThreadId.make("chat")));
const inbox = inboxAgentThread(onClaude(liveThreadShell(ThreadId.make("inbox"))) as never, true);
const voice = voiceAgentThread(
  onClaude(liveThreadShell(ThreadId.make("voice"))) as never,
  chat.id,
  chat,
);

it.each([
  ["inbox", inbox],
  ["voice", voice],
])("keeps a %s thread on its provider and title, with any model of it", (_kind, thread) => {
  expect(
    lockedAgentRefusesProvider(
      { modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" } },
      thread,
    ),
  ).toBe(true);
  expect(
    lockedAgentRefusesProvider(
      { modelSelection: { instanceId: claude, model: "claude-opus-5-5" } },
      thread,
    ),
  ).toBe(false);
  expect(lockedAgentRefusesProvider({}, thread)).toBe(false);
  expect(lockedAgentMessage({ text: "hi", titleSeed: "Rename me" }, thread)).toEqual({
    text: "hi",
  });
});

it("leaves every other thread's commands alone", () => {
  expect(
    lockedAgentRefusesProvider(
      { modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" } },
      chat,
    ),
  ).toBe(false);
  const command = { text: "hi", titleSeed: "A title" };
  expect(lockedAgentMessage(command, chat)).toBe(command);
});
