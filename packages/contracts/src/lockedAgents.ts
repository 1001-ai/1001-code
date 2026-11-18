import { BOARD_LIST_TOOL_NAME } from "./board.ts";
import { MEMORY_PROPOSE_TOOL_NAME } from "./memory.ts";
import type { OrchestrationV2AppThreadLineage } from "./orchestrationV2.ts";
import {
  VOICE_AGENT_BOARD_TOOL_NAME,
  VOICE_AGENT_SEND_MESSAGE_TOOL_NAME,
  VOICE_AGENT_SHOW_MEDIA_TOOL_NAME,
} from "./voiceAgent.ts";

/**
 * A locked agent is a hidden thread that runs on Claude with only its own tools: no shell, no
 * file tools, no built-ins. Its kind is read from its lineage, so the lock, the MCP gate and the
 * guard all follow the thread itself.
 */
export type LockedAgentKind = "voice" | "inbox";

export function lockedAgentKind(
  lineage: Pick<OrchestrationV2AppThreadLineage, "voiceAgent" | "inboxAgent">,
): LockedAgentKind | null {
  if (lineage.voiceAgent === true) return "voice";
  if (lineage.inboxAgent === true) return "inbox";
  return null;
}

/** Every tool a locked agent of each kind may list or call. Nothing else reaches it. */
export const LOCKED_AGENT_TOOL_NAMES: Readonly<Record<LockedAgentKind, ReadonlyArray<string>>> = {
  voice: [
    VOICE_AGENT_BOARD_TOOL_NAME,
    VOICE_AGENT_SEND_MESSAGE_TOOL_NAME,
    VOICE_AGENT_SHOW_MEDIA_TOOL_NAME,
    MEMORY_PROPOSE_TOOL_NAME,
  ],
  inbox: [
    "t3_thread_list",
    "t3_thread_read",
    "t3_thread_search",
    BOARD_LIST_TOOL_NAME,
    MEMORY_PROPOSE_TOOL_NAME,
  ],
};

/** The tools only a locked agent may list or call: every other caller is denied them. */
const LOCKED_AGENT_ONLY_TOOL_NAMES: ReadonlyArray<string> = [
  VOICE_AGENT_BOARD_TOOL_NAME,
  VOICE_AGENT_SEND_MESSAGE_TOOL_NAME,
  VOICE_AGENT_SHOW_MEDIA_TOOL_NAME,
];

/**
 * Whether a caller may list or call a tool of T3's MCP server: a locked agent only its own
 * kind's tools, and every other caller everything but the tools only locked agents have.
 */
export function lockedAgentToolAllowed(tool: string, kind: LockedAgentKind | null): boolean {
  return kind === null
    ? !LOCKED_AGENT_ONLY_TOOL_NAMES.includes(tool)
    : LOCKED_AGENT_TOOL_NAMES[kind].includes(tool);
}
