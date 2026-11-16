/**
 * A thread with T3's memory: the `<memory>` block and `memory_propose`, from source. With
 * `voiceAgent` the thread is the voice agent's, so it also gets its active memories' block. The
 * voice agent's own instructions do not exist yet; a case states its role in `setup.context`.
 */
import { buildMemoryBlock } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool } from "effect/ai";

import { advertisedJsonSchema } from "../../apps/server/src/mcp/advertisedJsonSchema.ts";
import { MemoryToolkit } from "../../apps/server/src/mcp/toolkits/memory/tools.ts";
import { buildVoiceAgentMemoryBlock } from "../../apps/server/src/memory/voiceAgentMemories.ts";

export const MemorySetup = Schema.Struct({
  /** The person's active voice agent memories, oldest first. */
  voiceAgent: Schema.optional(Schema.Array(Schema.String)),
});
type MemorySetup = typeof MemorySetup.Type;

/** The text T3 gives a Claude thread in a catalog project with nothing saved in its memory files. */
export const memoryText = (setup: MemorySetup): string =>
  [
    buildMemoryBlock({ documents: [], repository: null, proposable: true })?.text ?? "",
    ...(setup.voiceAgent === undefined
      ? []
      : [buildVoiceAgentMemoryBlock(setup.voiceAgent.map((text) => ({ text }))).text]),
  ].join("\n\n");

/** T3's memory tool, as Claude Code lists it from T3's MCP server. */
export const memoryTools = Object.values(MemoryToolkit.tools).map((tool: Tool.Any) => ({
  name: `mcp__t3-code__${tool.name}`,
  description: Tool.getDescription(tool) ?? "",
  input_schema: advertisedJsonSchema(tool),
}));

/** The memory block comes first, then the board's, as in a real turn. */
export const teamText = (...parts: ReadonlyArray<string | undefined>): string | undefined =>
  parts.filter((part) => part !== undefined).join("\n\n") || undefined;
