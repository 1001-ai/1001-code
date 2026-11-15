import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as Memory from "../../../memory/Memory.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { loadCaller } from "../../threadAccess.ts";
import { MemoryToolkit } from "./tools.ts";

const handlers = {
  memory_propose: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const { caller } = yield* loadCaller();
      if (caller === undefined) {
        return yield* new OrchestratorMcpFailure({
          code: "thread_credential_required",
          message: "Only an agent in a thread can propose a memory.",
        });
      }
      const memory = yield* Memory.Memory;
      const proposal = yield* memory
        .proposeFromAgent({
          projectId: caller.projectId,
          threadId: caller.id,
          threadTitle: caller.title,
          text: input.text,
          reason: input.reason,
        })
        .pipe(
          Effect.mapError(
            (error) =>
              new OrchestratorMcpFailure({ code: "invalid_request", message: error.detail }),
          ),
        );
      return {
        status: "pending" as const,
        proposalId: proposal.id,
        message:
          "Shown to the user as a card. Keep working; an accepted memory reaches agents from their next turn.",
      };
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof MemoryToolkit.tools>;

export const layer = McpToolAccess.toLayer(MemoryToolkit, handlers);
