import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import { forkParked } from "../serverActivation.ts";
import * as Board from "./Board.ts";
import { isLinearWriteToolName } from "./linearToolCalls.ts";

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
