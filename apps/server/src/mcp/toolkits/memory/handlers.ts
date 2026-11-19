import {
  MEMORY_WITHDRAW_TOOL_NAME,
  OrchestratorMcpFailure,
  type TeamCatalogError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as Memory from "../../../memory/Memory.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { loadCaller } from "../../threadAccess.ts";
import { MemoryToolkit } from "./tools.ts";

const threadCaller = Effect.fn("MemoryHandlers.threadCaller")(function* (action: string) {
  const { caller } = yield* loadCaller();
  if (caller === undefined) {
    return yield* new OrchestratorMcpFailure({
      code: "thread_credential_required",
      message: `Only an agent in a thread can ${action}.`,
    });
  }
  return caller;
});

const invalidRequest = (error: TeamCatalogError) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message: error.detail });

const handlers = {
  memory_propose: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const caller = yield* threadCaller("propose a memory");
      const memory = yield* Memory.Memory;
      const proposal = yield* memory
        .proposeFromAgent({
          projectId: caller.projectId,
          threadId: caller.id,
          threadTitle: caller.title,
          text: input.text,
          reason: input.reason,
          category: input.category,
          replaces: input.replaces,
        })
        .pipe(Effect.mapError(invalidRequest));
      return {
        status: "pending" as const,
        proposalId: proposal.id,
        message: `Shown to the user as a card. Keep working; an accepted memory reaches agents from their next turn. To take it back before the user answers, call ${MEMORY_WITHDRAW_TOOL_NAME} with this proposalId.`,
      };
    }),
  ),
  memory_withdraw: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const caller = yield* threadCaller("withdraw a memory proposal");
      const memory = yield* Memory.Memory;
      yield* memory
        .withdraw({ threadId: caller.id, proposalId: input.proposalId, reason: input.reason })
        .pipe(Effect.mapError(invalidRequest));
      return { status: "withdrawn" as const };
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof MemoryToolkit.tools>;

export const layer = McpToolAccess.toLayer(MemoryToolkit, handlers);
