import { INBOX_FORWARD_TOOL_NAME, OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { McpSchema, Tool, Toolkit } from "effect/ai";

import * as LinearInbox from "../../../board/LinearInbox.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

/** The Inbox's own tools. Only an Inbox thread lists or calls them (`lockedAgentToolAllowed`). */
const InboxForwardTool = Tool.make(INBOX_FORWARD_TOOL_NAME, {
  description:
    "Forward a teammate's message that arrived in this Inbox, unchanged, to the one thread of this project it belongs to. The thread gets the exact message, with its sender, and answers the teammate itself. You choose only the thread; you cannot change or add to the message.",
  parameters: Schema.Struct({
    threadId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)).annotate({
      description: "The thread to forward to: another thread of this project.",
    }),
    commentId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)).annotate({
      description:
        'The teammate\'s message, by the commentId its closing marker gives ("Answer with board_reply (commentId ...)").',
    }),
  }),
  success: Schema.Struct({
    threadId: Schema.String,
    messageId: Schema.String,
    delivery: Schema.String,
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    LinearInbox.LinearInbox,
  ],
})
  .annotate(Tool.Title, "Forward a teammate's message")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

export const InboxAgentToolkit = Toolkit.make(InboxForwardTool);
