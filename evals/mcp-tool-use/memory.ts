/**
 * A thread with T3's memory: the `<memory>` block and `memory_propose`, from source. With
 * `voiceAgent` the thread is the voice agent's: it gets the voice agent's instructions, its
 * active memories' block and its own tools, as that thread does, and no project memory.
 */
import { buildMemoryBlock } from "@t3tools/contracts";
import { VOICE_AGENT_INSTRUCTIONS } from "@t3tools/provider-core/server/runtimeInstructions";
import * as Schema from "effect/Schema";
import { Tool } from "effect/ai";

import { advertisedJsonSchema } from "../../apps/server/src/mcp/advertisedJsonSchema.ts";
import { MemoryToolkit } from "../../apps/server/src/mcp/toolkits/memory/tools.ts";
import { VoiceAgentToolkit } from "../../apps/server/src/mcp/toolkits/voiceAgent/tools.ts";
import { buildVoiceAgentMemoryBlock } from "../../apps/server/src/memory/voiceAgentMemories.ts";

export const MemorySetup = Schema.Struct({
  /** The person's active voice agent memories, oldest first. Makes the thread the voice agent's. */
  voiceAgent: Schema.optional(Schema.Array(Schema.String)),
});
type MemorySetup = typeof MemorySetup.Type;

/**
 * The text T3 gives the thread: for the voice agent its instructions and its memories, and for
 * any other Claude thread the memory block of a catalog project with nothing saved.
 */
export const memoryText = (setup: MemorySetup): string =>
  setup.voiceAgent === undefined
    ? (buildMemoryBlock({ documents: [], repository: null, proposable: true })?.text ?? "")
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
  setup.voiceAgent === undefined
    ? { loaded: [], deferred: listed(MemoryToolkit.tools) }
    : {
        loaded: [...listed(VoiceAgentToolkit.tools), ...listed(MemoryToolkit.tools)],
        deferred: [],
      };

/** The memory block comes first, then the board's, as in a real turn. */
export const teamText = (...parts: ReadonlyArray<string | undefined>): string | undefined =>
  parts.filter((part) => part !== undefined).join("\n\n") || undefined;
