/**
 * A thread with T3's memory block and `memory_propose`, from source. `voiceAgent` makes it the
 * voice agent's (its instructions, memories and tools, no project memory); `inboxAgent` makes it
 * a project's Inbox (its instructions, the project memory, its read tools and its forward listed
 * from the start).
 */
import { BOARD_LIST_TOOL_NAME, buildMemoryBlock } from "@t3tools/contracts";
import {
  INBOX_AGENT_INSTRUCTIONS,
  VOICE_AGENT_INSTRUCTIONS,
} from "@t3tools/provider-core/server/runtimeInstructions";
import * as Schema from "effect/Schema";
import { Tool } from "effect/ai";

import { advertisedJsonSchema } from "../../apps/server/src/mcp/advertisedJsonSchema.ts";
import { BoardToolkit } from "../../apps/server/src/mcp/toolkits/board/tools.ts";
import { InboxAgentToolkit } from "../../apps/server/src/mcp/toolkits/inboxAgent/tools.ts";
import { MemoryToolkit } from "../../apps/server/src/mcp/toolkits/memory/tools.ts";
import { VoiceAgentToolkit } from "../../apps/server/src/mcp/toolkits/voiceAgent/tools.ts";
import { buildVoiceAgentMemoryBlock } from "../../apps/server/src/memory/voiceAgentMemories.ts";

export const MemorySetup = Schema.Struct({
  /** The person's active voice agent memories, oldest first. Makes the thread the voice agent's. */
  voiceAgent: Schema.optional(Schema.Array(Schema.String)),
  /** Makes the thread a project's Inbox. */
  inboxAgent: Schema.optional(Schema.Boolean),
  /** Lines saved in the Inbox's project memory, such as a preference for the threads it starts. */
  inboxAgentMemories: Schema.optional(Schema.Array(Schema.String)),
});
type MemorySetup = typeof MemorySetup.Type;

/**
 * The text T3 gives the thread: for the voice agent its instructions and its memories, and for
 * any other Claude thread the memory block of a catalog project with nothing saved.
 */
const projectMemory = (lines: ReadonlyArray<string> = []) =>
  buildMemoryBlock({
    documents:
      lines.length === 0
        ? []
        : [
            {
              scope: "project",
              file: "memory/projects/app.md",
              label: "app",
              text: lines.map((line) => `- ${line}`).join("\n"),
            },
          ],
    repository: null,
    proposable: true,
  })?.text ?? "";

export const memoryText = (setup: MemorySetup): string =>
  setup.inboxAgent === true
    ? [INBOX_AGENT_INSTRUCTIONS, projectMemory(setup.inboxAgentMemories)].join("\n\n")
    : setup.voiceAgent === undefined
      ? projectMemory()
      : [
          VOICE_AGENT_INSTRUCTIONS,
          buildVoiceAgentMemoryBlock(setup.voiceAgent.map((text) => ({ text }))).text,
        ].join("\n\n");

const listed = (tools: Record<string, Tool.Any>) =>
  Object.values(tools).map((tool) => ({
    name: `mcp__t3-code__${tool.name}`,
    description: Tool.getDescription(tool) ?? "",
    input_schema: advertisedJsonSchema(tool),
  }));

/**
 * T3's memory tool, as Claude Code lists it from T3's MCP server. An ordinary thread loads it
 * through tool search. The voice agent's thread has a handful of tools and no others, so it
 * lists them all from the start: its own, and `memory_propose`.
 */
export const memoryTools = (setup: MemorySetup) =>
  setup.inboxAgent === true
    ? {
        // The thread tools are T3's own and come with them; the Board's list, memory and the
        // forward join here.
        loaded: [
          ...listed(BoardToolkit.tools).filter(
            (tool) => tool.name === `mcp__t3-code__${BOARD_LIST_TOOL_NAME}`,
          ),
          ...listed(MemoryToolkit.tools),
          ...listed(InboxAgentToolkit.tools),
        ],
        deferred: [],
      }
    : setup.voiceAgent === undefined
      ? { loaded: [], deferred: listed(MemoryToolkit.tools) }
      : {
          loaded: [...listed(VoiceAgentToolkit.tools), ...listed(MemoryToolkit.tools)],
          deferred: [],
        };

/** The memory block comes first, then the board's, as in a real turn. */
export const teamText = (...parts: ReadonlyArray<string | undefined>): string | undefined =>
  parts.filter((part) => part !== undefined).join("\n\n") || undefined;
