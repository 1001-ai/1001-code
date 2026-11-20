import {
  BOARD_ADD_TOOL_NAME,
  BOARD_LIST_TOOL_NAME,
  BOARD_MESSAGE_TOOL_NAME,
  BOARD_REPLY_TOOL_NAME,
  BOARD_UPDATE_TOOL_NAME,
  BoardTaskList,
  BoardTaskWriteResult,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { McpSchema, Tool, Toolkit } from "effect/ai";

import * as Board from "../../../board/Board.ts";
import * as LinearInbox from "../../../board/LinearInbox.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const Text = (description: string, max: number) =>
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(max)).annotate({ description });

const title = Text("The task's title: one line.", 255);
const description = Text("The task's description, in Markdown.", 50_000);
const status = Text(
  "A status of this board, by name, such as Todo or In Progress. Names that are not on the board are refused with the list of its statuses.",
  100,
);
const assignee = Text('"me" for the person you work for, or a team member\'s name or email.', 200);

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  Board.Board,
];

const messageText = Text(
  "What you want to say, in Markdown. Code adds the agent: prefix and this thread's reply address; write neither.",
  20_000,
);

const BoardMessageResult = Schema.Struct({
  task: Schema.String.annotate({ description: "The task the comment is on, such as ENG-12." }),
  commentId: Schema.String,
});

const BoardAddTool = Tool.make(BOARD_ADD_TOOL_NAME, {
  description:
    "File a task on this thread's project board, as the person you work for. The task gets this thread's link attached, so the board and teammates' agents find this thread.",
  parameters: Schema.Struct({
    title,
    description: Schema.optional(description),
    status: Schema.optional(status),
    assignee: Schema.optional(assignee),
  }),
  success: BoardTaskWriteResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Add a board task")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

const BoardUpdateTool = Tool.make(BOARD_UPDATE_TOOL_NAME, {
  description:
    "Change a task on this thread's project board: its status, assignee, title or description. Only the fields you give change. Also attaches this thread's link if the task does not have it yet.",
  parameters: Schema.Struct({
    task: Text("The task's identifier, such as ENG-12.", 50),
    title: Schema.optional(title),
    description: Schema.optional(description),
    status: Schema.optional(status),
    assignee: Schema.optional(assignee),
  }),
  success: BoardTaskWriteResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Update a board task")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

const BoardListTool = Tool.make(BOARD_LIST_TOOL_NAME, {
  description:
    "List the open tasks on this thread's project board, with each task's identifier, title, status, assignee and link.",
  // No `parameters`: an empty Schema.Struct({}) is not a valid MCP input schema.
  success: BoardTaskList,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "List board tasks")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

const BoardMessageTool = Tool.make(BOARD_MESSAGE_TOOL_NAME, {
  description:
    "Message a teammate's agent through Linear, as the person you work for: a comment on a task, or, with no task, on the teammate's Agent inbox task (made if missing). The comment carries this thread's reply address, so their answer comes back to this thread. Use it to ask or tell a teammate's agent something; answer a message you received with board_reply instead.",
  parameters: Schema.Struct({
    task: Schema.optional(Text("The task to comment on, such as ENG-12.", 50)),
    to: Schema.optional(
      Text("The teammate to message, by name or email, when there is no task.", 200),
    ),
    text: messageText,
  }),
  success: BoardMessageResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Message a teammate's agent")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

const BoardReplyTool = Tool.make(BOARD_REPLY_TOOL_NAME, {
  description:
    "Answer a teammate's Linear comment that was delivered to this thread, in its exchange on Linear, as the person you work for. The reply carries this thread's reply address. Share only what you choose to: the teammate sees the reply, not this thread.",
  parameters: Schema.Struct({
    commentId: Text("The comment's id, as its closing marker gives it.", 100),
    text: messageText,
  }),
  success: BoardMessageResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [...dependencies, LinearInbox.LinearInbox],
})
  .annotate(Tool.Title, "Reply to a teammate's comment")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

export const BoardToolkit = Toolkit.make(
  BoardAddTool,
  BoardUpdateTool,
  BoardListTool,
  BoardMessageTool,
  BoardReplyTool,
);
