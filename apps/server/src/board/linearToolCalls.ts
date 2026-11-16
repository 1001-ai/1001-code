import {
  BOARD_ADD_TOOL_NAME,
  BOARD_UPDATE_TOOL_NAME,
  BoardTaskWriteResult,
  type BoardTaskChange,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { readToolResultData } from "@t3tools/shared/toolOutput";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

const WRITE_VERB =
  "(?:save|create|delete|update|merge|resolve|submit|mark|share|unshare|retire|restore)_";
const WRITE_TOOL = new RegExp(`^${WRITE_VERB}`);
/** OpenCode joins the server (other characters made `_`) and the tool with `_`. */
const UNDERSCORED_LINEAR_WRITE = new RegExp(`^[\\w-]*linear[\\w-]*?_(${WRITE_VERB}[\\w-]*)$`);

/**
 * The Linear tool that changes Linear an MCP tool item calls, such as `save_issue`; null for reads
 * and other servers. Claude and Cursor name it `mcp__<server>__<tool>`, Codex and ACP agents
 * `<server>.<tool>`, OpenCode `<server>_<tool>`, and Codex's apps connector `<server>.linear_<tool>`.
 */
export function linearWriteTool(toolName: string | null | undefined): string | null {
  if (toolName == null) return null;
  const name = toolName.trim().toLowerCase();
  // Claude routes `mcp__a__b__tool` to server `a`, so the tool is what follows the last `__`.
  const split = name.startsWith("mcp__") ? name.lastIndexOf("__") : name.lastIndexOf(".");
  if (split <= 0) return UNDERSCORED_LINEAR_WRITE.exec(name)?.[1] ?? null;
  const server = name.slice(0, split);
  const tool = name.slice(name.startsWith("mcp__") ? split + 2 : split + 1);
  if (!server.includes("linear")) return UNDERSCORED_LINEAR_WRITE.exec(tool)?.[1] ?? null;
  return WRITE_TOOL.test(tool) ? tool : null;
}

export function isLinearWriteToolName(toolName: string | null | undefined): boolean {
  return linearWriteTool(toolName) !== null;
}

/** Linear's `save_issue` result; only what the card shows is required. */
const LinearIssueResult = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  url: Schema.String,
  status: Schema.String,
  statusType: Schema.optional(Schema.NullOr(Schema.String)),
  assignee: Schema.optional(Schema.NullOr(Schema.String)),
  assigneeId: Schema.optional(Schema.NullOr(Schema.String)),
  project: Schema.optional(Schema.NullOr(Schema.String)),
});
const decodeIssueResult = Schema.decodeUnknownOption(LinearIssueResult);

/** Linear's issue JSON carries the description, so allow more than a T3 tool's result. */
const MAX_RESULT_BYTES = 256 * 1024;
const MAX_TEXT_LENGTH = 500;
const MAX_URL_LENGTH = 2048;
const ISSUE_IDENTIFIER = /^[A-Za-z0-9_]{1,16}-\d{1,9}$/;

const nonEmpty = (value: unknown): value is string =>
  typeof value === "string" && value.trim() !== "";

const boundedText = (value: string | null | undefined) =>
  nonEmpty(value) ? value.slice(0, MAX_TEXT_LENGTH) : undefined;

const T3_SERVER = "t3-code(?:-direct)?|t3_code(?:_direct)?|t3code";
/**
 * T3's own board tools, only on T3's MCP server: `mcp__<server>__<tool>` (Claude, Cursor, Pi),
 * `<server>.<tool>` (Codex, ACP agents) and OpenCode's `t3-code_<tool>` or `t3-code-<thread>_<tool>`.
 */
const T3_BOARD_WRITE_TOOL = new RegExp(
  `^(?:mcp__(?:${T3_SERVER})__|(?:${T3_SERVER})\\.|t3-code(?:-[\\w-]+)?_)(${BOARD_ADD_TOOL_NAME}|${BOARD_UPDATE_TOOL_NAME})$`,
);

const decodeBoardWriteResult = Schema.decodeUnknownOption(BoardTaskWriteResult);

/** A T3 board tool's result in the shape of Linear's `save_issue` result. */
const boardWriteIssueResult = (data: unknown): typeof LinearIssueResult.Type | undefined =>
  Option.getOrUndefined(
    Option.map(decodeBoardWriteResult(data), ({ task }) => ({
      id: task.identifier,
      title: task.title,
      url: task.url,
      status: task.status.name,
      statusType: task.status.type,
      assignee: task.assignee,
      project: task.project,
    })),
  );

/**
 * Filing is `board_add` or a `save_issue` without `id`; an update counts when it sets the
 * assignee, else when it sets the state (`status` for `board_update`).
 */
function boardTaskChangeKind(tool: string, rawInput: unknown): BoardTaskChange["kind"] | null {
  if (tool === BOARD_ADD_TOOL_NAME) return "created";
  if (!Predicate.isObject(rawInput)) return null;
  // codex-acp sends `{ server, tool, arguments }` and Kiro `{ tool_id, arguments }`.
  const args = rawInput.arguments;
  const input =
    Predicate.isObject(args) &&
    (typeof rawInput.tool === "string" || typeof rawInput.tool_id === "string")
      ? args
      : rawInput;
  if (tool === "save_issue" && !nonEmpty(input.id)) return "created";
  if (nonEmpty(input.assignee)) return "picked_up";
  if (nonEmpty(tool === "save_issue" ? input.state : input.status)) return "status";
  return null;
}

/**
 * What a finished Linear `save_issue`, or T3 `board_add` or `board_update`, call did to a task;
 * undefined for anything else.
 */
export function boardTaskChange(item: OrchestrationV2TurnItem): BoardTaskChange | undefined {
  if (item.type !== "dynamic_tool" || item.status !== "completed") return undefined;
  const boardTool = T3_BOARD_WRITE_TOOL.exec(item.toolName?.trim().toLowerCase() ?? "")?.[1];
  const tool =
    boardTool ?? (linearWriteTool(item.toolName) === "save_issue" ? "save_issue" : undefined);
  if (tool === undefined) return undefined;
  const kind = boardTaskChangeKind(tool, item.input);
  if (kind === null) return undefined;
  const data = readToolResultData(item.output, MAX_RESULT_BYTES);
  const result =
    boardTool === undefined
      ? Option.getOrUndefined(decodeIssueResult(data))
      : boardWriteIssueResult(data);
  if (
    result === undefined ||
    !ISSUE_IDENTIFIER.test(result.id) ||
    !nonEmpty(result.url) ||
    result.url.length > MAX_URL_LENGTH
  ) {
    return undefined;
  }
  const statusType = boundedText(result.statusType);
  const assignee = boundedText(result.assignee);
  const assigneeId = boundedText(result.assigneeId);
  const project = boundedText(result.project);
  return {
    kind,
    identifier: result.id,
    title: result.title.slice(0, MAX_TEXT_LENGTH),
    url: result.url,
    status: result.status.slice(0, MAX_TEXT_LENGTH),
    ...(statusType === undefined ? {} : { statusType }),
    ...(assignee === undefined ? {} : { assignee }),
    ...(assigneeId === undefined ? {} : { assigneeId }),
    ...(project === undefined ? {} : { project }),
  };
}

/** Adds the card's data to a task-changing tool item's wire output. */
export function withBoardTaskChange(
  item: OrchestrationV2TurnItem,
  output: object | undefined,
): object | undefined {
  const boardTask = boardTaskChange(item);
  return boardTask === undefined ? output : { ...output, boardTask };
}
