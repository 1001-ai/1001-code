import {
  MemoryCategory,
  MEMORY_PROPOSAL_MAX_LENGTH,
  MEMORY_PROPOSAL_REASON_MAX_LENGTH,
  MEMORY_PROPOSE_TOOL_NAME,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as Memory from "../../../memory/Memory.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

// Touches only the caller's thread and the user's review queue, so plan mode and read-only
// sandboxes may propose too.
const MemoryProposeTool = Tool.make(MEMORY_PROPOSE_TOOL_NAME, {
  description:
    "Propose a memory for this project's later threads: a preference the user stated, a correction they repeated, or a fact you learned. The user sees it as a card in the chat and accepts it for themselves or the team, or rejects it. Returns at once; keep working, and do not wait for, ask about, or repeat it.",
  parameters: Schema.Struct({
    text: Schema.String.check(
      Schema.isMinLength(1),
      Schema.isMaxLength(MEMORY_PROPOSAL_MAX_LENGTH),
    ).annotate({ description: "The memory: one short line in plain words." }),
    reason: Schema.String.check(Schema.isMaxLength(MEMORY_PROPOSAL_REASON_MAX_LENGTH)).annotate({
      description: "Why it is worth remembering, such as the user correcting you twice.",
    }),
    category: Schema.optional(
      MemoryCategory.annotate({
        description:
          'Only the voice agent sets this, to "voice-agent-memories", for how the user wants its spoken updates: their detail and topics. Leave it out for every other memory.',
      }),
    ),
    replaces: Schema.optional(
      Schema.String.check(
        Schema.isMinLength(1),
        Schema.isMaxLength(MEMORY_PROPOSAL_MAX_LENGTH),
      ).annotate({
        description:
          'Only with category "voice-agent-memories": the exact text of the active memory this one changes or contradicts. The new memory takes its place. Leave it out for a new subject.',
      }),
    ),
  }),
  success: Schema.Struct({
    status: Schema.Literal("pending"),
    proposalId: Schema.String,
    message: Schema.String,
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    Memory.Memory,
  ],
})
  .annotate(Tool.Title, "Propose a memory")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const MemoryToolkit = Toolkit.make(MemoryProposeTool);
