import {
  BOARD_ADD_TOOL_NAME,
  BOARD_LIST_TOOL_NAME,
  BOARD_UPDATE_TOOL_NAME,
  BoardTaskList,
  BoardTaskWriteResult,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as Board from "../../../board/Board.ts";
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
  .annotate(Tool.OpenWorld, true);

const BoardUpdateTool = Tool.make(BOARD_UPDATE_TOOL_NAME, {
  description:
    "Change a task on this thread's project board: its status, assignee, title or description. Only the fields you give change. Also attaches this thread's link if the task does not have it yet.",
  parameters: Schema.Struct({
    task: Text("The task's identifier, such as COD-12.", 50),
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
  .annotate(Tool.OpenWorld, true);

const BoardListTool = Tool.make(BOARD_LIST_TOOL_NAME, {
  description:
    "List the open tasks on this thread's project board, with each task's identifier, title, status, assignee and link.",
  parameters: Schema.Struct({}),
  success: BoardTaskList,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "List board tasks")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

export const BoardToolkit = Toolkit.make(BoardAddTool, BoardUpdateTool, BoardListTool);
