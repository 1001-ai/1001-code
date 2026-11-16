import { type OrchestrationV2AppThread, VOICE_AGENT_TOOL_NAMES } from "@t3tools/contracts";
import { VOICE_AGENT_INSTRUCTIONS } from "@t3tools/provider-core/server/runtimeInstructions";

import type { ClaudeAgentSdkQueryOptions } from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { isVoiceAgentThread } from "./voiceAgentThread.ts";

/** The name of T3's MCP server in a Claude query; its tools are `mcp__<server>__<tool>`. */
const T3_MCP_SERVER = "t3-code";

/** The only tools a voice agent's Claude process may call, under Claude's names for them. */
const VOICE_AGENT_CLAUDE_ALLOWED_TOOLS: ReadonlyArray<string> = VOICE_AGENT_TOOL_NAMES.map(
  (tool) => `mcp__${T3_MCP_SERVER}__${tool}`,
);

/**
 * Claude Code's own tools. `tools: []` already leaves every one of them out; they are named
 * again as disallowed so a change to how the adapter picks tools cannot bring one back.
 */
const VOICE_AGENT_CLAUDE_DISALLOWED_TOOLS: ReadonlyArray<string> = [
  "Bash",
  "BashOutput",
  "KillShell",
  "KillBash",
  "Edit",
  "MultiEdit",
  "Write",
  "NotebookEdit",
  "Read",
  "Glob",
  "Grep",
  "LS",
  "WebFetch",
  "WebSearch",
  "Task",
  "Agent",
  "Skill",
  "SlashCommand",
  "TodoWrite",
  "ExitPlanMode",
  "EnterPlanMode",
  "AskUserQuestion",
  "ToolSearch",
  "Workflow",
  "Monitor",
];

/**
 * Rewrites the Claude query of a voice agent thread so it can call its own MCP tools and nothing
 * else, whatever the user's runtime mode is; every other thread's query is returned as it is.
 * Each override below closes one way to a shell, a file or another tool: fork/README.md lists them.
 */
export function lockClaudeQueryForVoiceAgent(
  options: ClaudeAgentSdkQueryOptions,
  thread: Pick<OrchestrationV2AppThread, "lineage">,
  memory: string | undefined,
): ClaudeAgentSdkQueryOptions {
  if (!isVoiceAgentThread(thread)) return options;
  const {
    allowDangerouslySkipPermissions: _skipPermissions,
    additionalDirectories: _directories,
    extraArgs: _extraArgs,
    hooks: _hooks,
    agents: _agents,
    plugins: _plugins,
    skills: _skills,
    promptSuggestions: _suggestions,
    ...kept
  } = options;
  const t3 = options.mcpServers?.[T3_MCP_SERVER];
  return {
    ...kept,
    tools: [],
    allowedTools: [...VOICE_AGENT_CLAUDE_ALLOWED_TOOLS],
    disallowedTools: [...VOICE_AGENT_CLAUDE_DISALLOWED_TOOLS],
    permissionMode: "dontAsk",
    strictMcpConfig: true,
    // The user's own settings hold their sign-in; the project's hold nothing this thread may use.
    settingSources: ["user"],
    promptSuggestions: false,
    // The user waits to hear the answer.
    thinking: { type: "disabled" },
    mcpServers: t3 === undefined ? {} : { [T3_MCP_SERVER]: t3 },
    systemPrompt: [VOICE_AGENT_INSTRUCTIONS, ...(memory === undefined ? [] : [memory])].join(
      "\n\n",
    ),
  };
}
