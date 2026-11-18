import {
  LOCKED_AGENT_TOOL_NAMES,
  type LockedAgentKind,
  type OrchestrationV2AppThread,
} from "@t3tools/contracts";
import {
  INBOX_AGENT_INSTRUCTIONS,
  VOICE_AGENT_INSTRUCTIONS,
} from "@t3tools/provider-core/server/runtimeInstructions";

import type { ClaudeAgentSdkQueryOptions } from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { lockedAgentKindOf } from "./lockedAgentKind.ts";

/** The name of T3's MCP server in a Claude query; its tools are `mcp__<server>__<tool>`. */
const T3_MCP_SERVER = "t3-code";

interface LockedAgentProfile {
  readonly instructions: string;
  /** The voice agent answers aloud, so it does not think first; the Inbox keeps the thread's. */
  readonly thinkingOff: boolean;
}

const PROFILES: Readonly<Record<LockedAgentKind, LockedAgentProfile>> = {
  voice: { instructions: VOICE_AGENT_INSTRUCTIONS, thinkingOff: true },
  inbox: { instructions: INBOX_AGENT_INSTRUCTIONS, thinkingOff: false },
};

/** The only tools a locked agent's Claude process may call, under Claude's names for them. */
function lockedAgentClaudeAllowedTools(kind: LockedAgentKind): Array<string> {
  return LOCKED_AGENT_TOOL_NAMES[kind].map((tool) => `mcp__${T3_MCP_SERVER}__${tool}`);
}

/**
 * Claude Code's own tools. `tools: []` already leaves every one of them out; they are named
 * again as disallowed so a change to how the adapter picks tools cannot bring one back.
 */
const LOCKED_AGENT_CLAUDE_DISALLOWED_TOOLS: ReadonlyArray<string> = [
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
 * Rewrites the Claude query of a locked agent thread (the voice agent, a project's Inbox) so it
 * can call its own MCP tools and nothing else, whatever the user's runtime mode is; every other
 * thread's query is returned as it is. Each override below closes one way to a shell, a file or
 * another tool: fork/README.md lists them.
 */
export function lockClaudeQueryForLockedAgent(
  options: ClaudeAgentSdkQueryOptions,
  thread: Pick<OrchestrationV2AppThread, "id" | "lineage">,
  memory: string | undefined,
): ClaudeAgentSdkQueryOptions {
  const kind = lockedAgentKindOf(thread);
  if (kind === null) return options;
  const profile = PROFILES[kind];
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
  // The one launch flag kept: how the adapter asked for thinking to show. It adds no tool.
  const thinkingDisplay = profile.thinkingOff ? undefined : options.extraArgs?.["thinking-display"];
  return {
    ...kept,
    tools: [],
    allowedTools: lockedAgentClaudeAllowedTools(kind),
    disallowedTools: [...LOCKED_AGENT_CLAUDE_DISALLOWED_TOOLS],
    permissionMode: "dontAsk",
    strictMcpConfig: true,
    // The user's own settings hold their sign-in; the project's hold nothing this thread may use.
    settingSources: ["user"],
    promptSuggestions: false,
    ...(profile.thinkingOff ? { thinking: { type: "disabled" as const } } : {}),
    ...(thinkingDisplay === undefined
      ? {}
      : { extraArgs: { "thinking-display": thinkingDisplay } }),
    mcpServers: t3 === undefined ? {} : { [T3_MCP_SERVER]: t3 },
    systemPrompt: [profile.instructions, ...(memory === undefined ? [] : [memory])].join("\n\n"),
  };
}
