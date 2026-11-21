import {
  MemoryCategory,
  MEMORY_PROPOSAL_MAX_LENGTH,
  MEMORY_PROPOSAL_REASON_MAX_LENGTH,
  MEMORY_PROPOSE_TOOL_NAME,
  MEMORY_WITHDRAW_TOOL_NAME,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { McpSchema, Tool, Toolkit } from "effect/ai";

import * as Memory from "../../../memory/Memory.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  Memory.Memory,
];

// Both touch only the caller's thread and the user's review queue, so plan mode and read-only
// sandboxes may use them too.
const MemoryProposeTool = Tool.make(MEMORY_PROPOSE_TOOL_NAME, {
  description:
    "Propose a memory for this project's later threads: a preference the user stated, a correction they repeated, or a fact you learned. To change or remove a saved memory, give replaces. The user sees it as a card in the chat and accepts or rejects it. Returns at once; keep working, and do not wait for, ask about, or repeat it.",
  parameters: Schema.Struct({
    text: Schema.optional(
      Schema.String.check(
        Schema.isMinLength(1),
        Schema.isMaxLength(MEMORY_PROPOSAL_MAX_LENGTH),
      ).annotate({
        description:
          'The memory: one short line in plain words. Write it neutrally (avoid "me" or the user\'s name), since it may be accepted for the team. With replaces, the line that takes its place; leave text out to remove that line.',
      }),
    ),
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
          'The exact text of a saved memory line, without its list bullet, that this one changes (with text) or removes (without text). With category "voice-agent-memories": the active memory this one changes or contradicts. Leave it out for a new memory.',
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
  dependencies,
})
  .annotate(Tool.Title, "Propose a memory")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

const MemoryWithdrawTool = Tool.make(MEMORY_WITHDRAW_TOOL_NAME, {
  description:
    "Take back a memory this thread proposed that the user has not answered yet, such as one you found to be wrong. Its card shows it withdrawn, with your reason.",
  parameters: Schema.Struct({
    proposalId: Schema.String.check(Schema.isMinLength(1)).annotate({
      description: `The proposalId ${MEMORY_PROPOSE_TOOL_NAME} returned.`,
    }),
    reason: Schema.String.check(Schema.isMaxLength(MEMORY_PROPOSAL_REASON_MAX_LENGTH)).annotate({
      description: "Why you take it back, in a few words.",
    }),
  }),
  success: Schema.Struct({ status: Schema.Literal("withdrawn") }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Withdraw a memory proposal")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

export const MemoryToolkit = Toolkit.make(MemoryProposeTool, MemoryWithdrawTool);
