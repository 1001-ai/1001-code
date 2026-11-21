import {
  type LockedAgentKind,
  type OrchestrationV2AppThread,
  type ThreadId,
  lockedAgentToolAllowed,
} from "@t3tools/contracts";
import {
  INBOX_AGENT_INSTRUCTIONS,
  VOICE_AGENT_INSTRUCTIONS,
} from "@t3tools/provider-core/server/runtimeInstructions";
import type * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import {
  type AcpPermissionDisposition,
  unknownRecord,
} from "@t3tools/provider-acp/server/clientPolicy";
import * as Effect from "effect/Effect";
import type * as EffectAcpSchema from "effect-acp/compat";
import * as EffectAcpErrors from "effect-acp/errors";

import { isInboxThread } from "../inboxAgent/inboxAgentThreads.ts";
import type { AntigravityAcpRuntimeInput } from "../provider/acp/AntigravityAcpSupport.ts";
import { lockedAgentKindOf } from "./lockedAgentKind.ts";

/** The name of T3's MCP server in an Antigravity ACP session. */
const T3_MCP_SERVER = "t3-code";

/** Environment variables that expose the ACP shell-to-MCP fallback; stripped for locked agents. */
const ACP_MCP_SHELL_ENV_KEYS = new Set([
  "T3_ACP_MCP_ENDPOINT",
  "T3_ACP_MCP_AUTHORIZATION",
  "T3_ACP_MCP_NODE",
  "T3_ACP_MCP_ENTRYPOINT",
]);

const INSTRUCTIONS: Readonly<Record<LockedAgentKind, string>> = {
  voice: VOICE_AGENT_INSTRUCTIONS,
  inbox: INBOX_AGENT_INSTRUCTIONS,
};

/**
 * Antigravity's built-in tools across 1.4.x (`BuiltinTools`) and 1.5.x. `enabledTools: []`
 * already disables every built-in tool (including subagents, browser subagent and future tools);
 * naming them in `disabledTools` as well provides defense-in-depth if a runtime ignores
 * `enabledTools`.
 */
export const LOCKED_AGENT_ANTIGRAVITY_DISABLED_TOOLS: ReadonlyArray<string> = [
  "run_command",
  "view_file",
  "create_file",
  "edit_file",
  "list_directory",
  "search_directory",
  "find_file",
  "search_web",
  "read_url_content",
  "invoke_subagent",
  "start_subagent",
  "run_workflow",
  "generate_image",
  "ask_question",
  "schedule",
  "finish",
  "read_file",
  "write_file",
  "manage_task",
  "send_message",
  "define_subagent",
  "manage_subagents",
  "swarm",
  "list_resources",
  "read_resource",
];

type LockedThreadRef =
  | Pick<OrchestrationV2AppThread, "id" | "lineage">
  | ThreadId
  | null
  | undefined;

function lockedKindFor(thread: LockedThreadRef): LockedAgentKind | null {
  if (thread == null) return null;
  if (typeof thread === "string") return isInboxThread(thread) ? "inbox" : null;
  return lockedAgentKindOf(thread);
}

export function isLockedAntigravityThread(thread: LockedThreadRef): boolean {
  return lockedKindFor(thread) !== null;
}

/**
 * Antigravity 1.4.5+ reads `_meta.antigravity.systemPrompt.append` on new/load/resume.
 * Older runtimes ignore it, so locked prompts include the instructions inline.
 */
function antigravitySupportsSystemPromptAppend(
  initializeResult: EffectAcpSchema.InitializeResponse | null | undefined,
): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(initializeResult?.agentInfo?.version?.trim() ?? "");
  if (match === null) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (major !== 1) return major > 1;
  if (minor !== 4) return minor > 4;
  return patch >= 5;
}

/** The `_meta` sent on `session/new`, `session/load`, and `session/resume` for a locked agent. */
function antigravityLockedSessionMeta(
  kind: LockedAgentKind,
  memory?: string,
): NonNullable<EffectAcpSchema.NewSessionRequest["_meta"]> {
  return {
    antigravity: {
      enabledTools: [],
      disabledTools: [...LOCKED_AGENT_ANTIGRAVITY_DISABLED_TOOLS],
      eagerMcpServers: [T3_MCP_SERVER],
      systemPrompt: {
        append: [INSTRUCTIONS[kind], ...(memory === undefined ? [] : [memory])].join("\n\n"),
      },
    },
  };
}

function keepOnlyT3McpServers(
  servers: ReadonlyArray<EffectAcpSchema.McpServer> | undefined,
): ReadonlyArray<EffectAcpSchema.McpServer> | undefined {
  return servers === undefined
    ? undefined
    : servers.filter((server) => server.name === T3_MCP_SERVER);
}

function stripShellMcpEnv(env: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv | undefined {
  if (env === undefined) return undefined;
  const kept: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (!ACP_MCP_SHELL_ENV_KEYS.has(key)) kept[key] = value;
  }
  return Object.keys(kept).length === 0 ? undefined : kept;
}

/**
 * Locks Antigravity ACP runtime input for locked agents to `t3-code` MCP tools only: disables
 * built-ins, client FS/terminal capabilities, extra MCP servers and shell-fallback env vars.
 */
export function lockAntigravityRuntimeInputForLockedAgent<
  Input extends Omit<AntigravityAcpRuntimeInput, "spawn" | "childProcessSpawner"> & {
    readonly processEnvironment?: NodeJS.ProcessEnv;
  },
>(options: Input, thread: LockedThreadRef, memory?: string): Input {
  const kind = lockedKindFor(thread);
  if (kind === null) return options;
  const {
    additionalDirectories: _additionalDirectories,
    sessionSystemPromptAppend: _sessionSystemPromptAppend,
    sessionMeta: _sessionMeta,
    processEnvironment,
    ...kept
  } = options;
  const cleanedEnv = stripShellMcpEnv(processEnvironment);
  const mcpServers = keepOnlyT3McpServers(options.mcpServers);
  const acpMcpServers = keepOnlyT3McpServers(options.acpMcpServers);
  const httpMcpServers = keepOnlyT3McpServers(options.httpMcpServers);
  return {
    ...kept,
    clientFileReads: false,
    clientCapabilities: {
      ...kept.clientCapabilities,
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
    },
    ...(mcpServers === undefined ? {} : { mcpServers }),
    ...(acpMcpServers === undefined ? {} : { acpMcpServers }),
    ...(httpMcpServers === undefined ? {} : { httpMcpServers }),
    ...(cleanedEnv === undefined ? {} : { processEnvironment: cleanedEnv }),
    sessionMeta: () => antigravityLockedSessionMeta(kind, memory),
  } as unknown as Input;
}

/**
 * Wraps an Antigravity ACP runtime for a locked agent thread so it stays in `"default"` mode
 * (never `"yolo"` or `"auto_edit"`, so every tool call passes the client permission gate) and
 * refuses any `fs/read_text_file` callback even if the agent calls it unadvertised.
 */
export function lockAntigravityRuntimeForLockedAgent<
  Runtime extends Pick<
    AcpSessionRuntime.AcpSessionRuntime["Service"],
    "setMode" | "handleReadTextFile"
  >,
>(runtime: Runtime, thread: LockedThreadRef): Runtime {
  if (lockedKindFor(thread) === null) return runtime;
  return {
    ...runtime,
    setMode: () => runtime.setMode("default"),
    handleReadTextFile: () =>
      runtime.handleReadTextFile(() =>
        Effect.fail(
          EffectAcpErrors.AcpRequestError.invalidParams(
            "File access is disabled for this locked agent.",
          ),
        ),
      ),
  };
}

const T3_MCP_TITLE_PATTERNS: ReadonlyArray<RegExp> = [
  /^t3-code_([a-z0-9_]+)$/,
  /^mcp__t3-code__([a-z0-9_]+)$/,
  /^mcp_t3-code_([a-z0-9_]+)$/,
  /^t3-code[.:/]([a-z0-9_]+)$/,
  /^Permit ([a-z0-9_]+) on t3-code$/,
  /^Run (?:mcp_)?t3-code_([a-z0-9_]+)\?$/,
];

function extractAllowedT3McpToolFromPermission(
  request: EffectAcpSchema.RequestPermissionRequest,
  kind: LockedAgentKind,
): string | null {
  const { toolCall } = request;
  if (toolCall.toolCallId.startsWith("interaction_")) return null;
  if (toolCall.kind != null && toolCall.kind !== "other") return null;
  if (toolCall.locations != null && toolCall.locations.length > 0) return null;

  const meta = unknownRecord(toolCall._meta);
  if (meta !== undefined) {
    const mcp = unknownRecord(meta.mcp);
    if (mcp !== undefined || meta.is_mcp_tool_call === true) {
      return mcp?.server === T3_MCP_SERVER &&
        typeof mcp.tool === "string" &&
        lockedAgentToolAllowed(mcp.tool, kind)
        ? mcp.tool
        : null;
    }
    if (typeof meta.serverId === "string" || typeof meta.toolName === "string") {
      return meta.serverId === T3_MCP_SERVER &&
        typeof meta.toolName === "string" &&
        lockedAgentToolAllowed(meta.toolName, kind)
        ? meta.toolName
        : null;
    }
  }

  const rawInput = unknownRecord(toolCall.rawInput);
  if (
    rawInput !== undefined &&
    (typeof rawInput.ServerName === "string" || typeof rawInput.ToolName === "string")
  ) {
    return rawInput.ServerName === T3_MCP_SERVER &&
      typeof rawInput.ToolName === "string" &&
      lockedAgentToolAllowed(rawInput.ToolName, kind)
      ? rawInput.ToolName
      : null;
  }

  const title = toolCall.title?.trim();
  if (!title) return null;
  for (const pattern of T3_MCP_TITLE_PATTERNS) {
    const match = pattern.exec(title);
    const tool = match?.[1];
    if (tool !== undefined && lockedAgentToolAllowed(tool, kind)) {
      return tool;
    }
  }
  return null;
}

/**
 * Client-boundary permission gate for a locked Antigravity thread: auto-allows ONLY calls to
 * `LOCKED_AGENT_TOOL_NAMES[kind]` on `t3-code`, and denies everything else immediately (never
 * prompting the user). Returns `undefined` for ordinary threads so normal policy applies.
 */
export function lockedAgentAntigravityPermissionDisposition(
  request: EffectAcpSchema.RequestPermissionRequest,
  thread: LockedThreadRef,
): AcpPermissionDisposition | undefined {
  const kind = lockedKindFor(thread);
  if (kind === null) return undefined;
  return extractAllowedT3McpToolFromPermission(request, kind) !== null ? "allow" : "deny";
}

/**
 * Formats a locked Antigravity turn prompt, replacing T3's default ACP prompt wrapping.
 * Prepends project memory (and inline instructions on runtimes older than 1.4.5).
 */
export function lockAntigravityPromptForLockedAgent(input: {
  readonly text: string;
  readonly thread: LockedThreadRef;
  readonly memory?: string | undefined;
  readonly initializeResult?: EffectAcpSchema.InitializeResponse | null | undefined;
}): string | undefined {
  const kind = lockedKindFor(input.thread);
  if (kind === null) return undefined;
  const parts: Array<string> = [];
  if (!antigravitySupportsSystemPromptAppend(input.initializeResult)) {
    parts.push(INSTRUCTIONS[kind]);
  }
  if (input.memory !== undefined) {
    parts.push(input.memory);
  }
  parts.push(input.text);
  return parts.join("\n\n");
}
