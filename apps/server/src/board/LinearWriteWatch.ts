import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import { forkParked } from "../serverActivation.ts";
import * as Board from "./Board.ts";

const WRITE_VERB =
  "(?:save|create|delete|update|merge|resolve|submit|mark|share|unshare|retire|restore)_";
const WRITE_TOOL = new RegExp(`^${WRITE_VERB}`);
/** OpenCode joins the server (other characters made `_`) and the tool with `_`. */
const UNDERSCORED_LINEAR_WRITE = new RegExp(`^[\\w-]*linear[\\w-]*?_${WRITE_VERB}`);

/**
 * Whether an MCP tool item is a Linear tool that changes Linear. Claude and Cursor name it
 * `mcp__<server>__<tool>`, Codex and ACP agents `<server>.<tool>`, OpenCode `<server>_<tool>`.
 */
export function isLinearWriteToolName(toolName: string | null | undefined): boolean {
  if (toolName == null) return false;
  const name = toolName.trim().toLowerCase();
  // Claude routes `mcp__a__b__tool` to server `a`, so the tool is what follows the last `__`.
  const split = name.startsWith("mcp__") ? name.lastIndexOf("__") : name.lastIndexOf(".");
  if (split <= 0) return UNDERSCORED_LINEAR_WRITE.test(name);
  const server = name.slice(0, split);
  const tool = name.slice(name.startsWith("mcp__") ? split + 2 : split + 1);
  return server.includes("linear") && WRITE_TOOL.test(tool);
}

/** Enough to dedupe the repeated updates a finished item gets; older ids are forgotten. */
const MAX_REMEMBERED_ITEMS = 500;

/** Refreshes the open boards once an agent's Linear write finishes, instead of at the next poll. */
export const watch = Effect.gen(function* () {
  const board = yield* Board.Board;
  const engine = yield* Orchestrator.OrchestratorV2;
  const seen = new Set<string>();
  yield* forkParked(
    Stream.runForEach(engine.streamDomainEvents, (event) => {
      if (event.type !== "turn-item.updated") return Effect.void;
      const item = event.payload;
      if (
        item.type !== "dynamic_tool" ||
        item.status !== "completed" ||
        !isLinearWriteToolName(item.toolName) ||
        seen.has(item.id)
      ) {
        return Effect.void;
      }
      seen.add(item.id);
      if (seen.size > MAX_REMEMBERED_ITEMS) seen.delete(seen.values().next().value ?? "");
      return board.refreshOpen;
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Board stopped watching for agents' Linear writes.", cause),
      ),
    ),
  );
});

export const layer = Layer.effectDiscard(watch);
