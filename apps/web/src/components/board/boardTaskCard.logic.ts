import { BoardTaskChange, type OrchestrationV2TurnItem } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

const decodeBoardTask = Schema.decodeUnknownOption(BoardTaskChange);

/** What the agent's Linear call did to a task, which the server reads from Linear's result. */
export function boardTaskChangeOf(item: OrchestrationV2TurnItem): BoardTaskChange | null {
  if (item.type !== "dynamic_tool" || item.status !== "completed") return null;
  const output = item.output;
  if (!Predicate.isObject(output) || output.isError === true || output.boardTask === undefined) {
    return null;
  }
  return Option.getOrNull(decodeBoardTask(output.boardTask));
}

/** A Linear call that filed, picked up or moved a task; anything else stays a tool row. */
export function isBoardTaskItem(item: OrchestrationV2TurnItem): boolean {
  return boardTaskChangeOf(item) !== null;
}

export type BoardStatusGlyph =
  | "backlog"
  | "unstarted"
  | "started"
  | "review"
  | "completed"
  | "canceled";

/** Linear's status icon. Review states are `started` too, so the name tells them apart. */
export function boardStatusGlyph(statusType: string | undefined, name: string): BoardStatusGlyph {
  switch (statusType) {
    case "backlog":
    case "completed":
    case "canceled":
      return statusType;
    case "started":
      return /review/i.test(name) ? "review" : "started";
    default:
      return "unstarted";
  }
}
