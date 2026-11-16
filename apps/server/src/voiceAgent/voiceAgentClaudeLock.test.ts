import { ProviderInstanceId, ThreadId, VOICE_AGENT_TOOL_NAMES } from "@t3tools/contracts";
import { VOICE_AGENT_INSTRUCTIONS } from "@t3tools/provider-core/server/runtimeInstructions";
import { expect, it } from "vitest";

import { liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import { makeClaudeQueryOptions } from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { lockClaudeQueryForVoiceAgent } from "./voiceAgentClaudeLock.ts";
import { voiceAgentThread } from "./voiceAgentThread.ts";

const chat = liveThreadShell(ThreadId.make("chat-1"));
const voice = voiceAgentThread(chat as never, chat.id, chat);

/** The widest query the adapter builds: Full access, every tool, the user's own launch flags. */
const fullAccess = () =>
  makeClaudeQueryOptions({
    modelSelection: {
      instanceId: ProviderInstanceId.make("claudeAgent"),
      model: "claude-haiku-5-5",
    },
    nativeThreadId: "native-1",
    resume: false,
    cwd: "/home/user/app",
    attachmentsDir: "/home/user/attachments",
    settings: {
      launchArgs: "--mcp-config /home/user/servers.json --allowedTools Bash --add-dir /home/user",
    } as never,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    allowedTools: ["mcp__t3-code__*", "Bash"],
    mcpServers: {
      "t3-code": { type: "http", url: "http://127.0.0.1/mcp" },
      other: { type: "http", url: "http://127.0.0.1/other" },
    },
    canUseTool: async () => ({ behavior: "allow", updatedInput: {} }),
    memory: "<memory>project memory</memory>",
  });

it("gives a voice agent thread its own tools and nothing that runs commands or touches files", () => {
  const unlocked = fullAccess();
  // The premise: without the lock this thread could do anything.
  expect(unlocked.tools).toEqual({ type: "preset", preset: "claude_code" });
  expect(unlocked.permissionMode).toBe("bypassPermissions");

  const locked = lockClaudeQueryForVoiceAgent(
    unlocked,
    voice,
    "<voice_agent_memories>brief</voice_agent_memories>",
  );
  expect(locked.tools).toEqual([]);
  expect(locked.allowedTools).toEqual(
    VOICE_AGENT_TOOL_NAMES.map((tool) => `mcp__t3-code__${tool}`),
  );
  for (const tool of ["Bash", "Edit", "Write", "Read", "NotebookEdit", "Task", "WebFetch"]) {
    expect(locked.disallowedTools).toContain(tool);
    expect(locked.allowedTools).not.toContain(tool);
  }
  expect(locked.allowedTools?.some((tool) => tool.includes("*"))).toBe(false);
  // Nothing is asked and nothing is skipped: a call that is not on the list is denied.
  expect(locked.permissionMode).toBe("dontAsk");
  expect(locked).not.toHaveProperty("allowDangerouslySkipPermissions");
  // Only T3's own MCP server, and no server from a settings file, a plugin or a launch flag.
  expect(locked.strictMcpConfig).toBe(true);
  expect(Object.keys(locked.mcpServers ?? {})).toEqual(["t3-code"]);
  expect(locked.settingSources).toEqual(["user"]);
  expect(locked).not.toHaveProperty("extraArgs");
  expect(locked).not.toHaveProperty("additionalDirectories");
  expect(locked).not.toHaveProperty("hooks");
  // Its own instructions and the person's voice memories; not Claude Code's prompt or the project's memory.
  expect(locked.systemPrompt).toBe(
    `${VOICE_AGENT_INSTRUCTIONS}\n\n<voice_agent_memories>brief</voice_agent_memories>`,
  );
  // The sign-in and the model are the adapter's.
  expect(locked.model).toBe(unlocked.model);
  expect(locked.cwd).toBe("/home/user/app");
});

it("leaves every other thread's query as the adapter built it", () => {
  const unlocked = fullAccess();
  expect(lockClaudeQueryForVoiceAgent(unlocked, chat, undefined)).toBe(unlocked);
  expect(
    lockClaudeQueryForVoiceAgent(
      unlocked,
      { lineage: { ...chat.lineage, sideChat: true, relationshipToParent: "fork" } },
      undefined,
    ),
  ).toBe(unlocked);
});
