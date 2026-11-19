import { OrchestratorMcpFailure, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as LinearInbox from "../../../board/LinearInbox.ts";
import { isInboxThread } from "../../../inboxAgent/inboxAgentThreads.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { loadCaller } from "../../threadAccess.ts";
import { InboxAgentToolkit } from "./tools.ts";

const handlers = {
  inbox_forward: McpToolAccess.actsAsCaller(({ threadId, commentId }) =>
    Effect.gen(function* () {
      const { scope, caller } = yield* loadCaller();
      if (caller === undefined || !isInboxThread(caller.id)) {
        return yield* new OrchestratorMcpFailure({
          code: "capability_denied",
          message: "Only a project's Inbox can forward a teammate's message.",
        });
      }
      const inbox = yield* LinearInbox.LinearInbox;
      return yield* inbox
        .forward({
          inboxThreadId: caller.id,
          environmentId: scope.environmentId,
          forward: { threadId: ThreadId.make(threadId), commentId },
        })
        .pipe(
          Effect.mapError(
            (error) =>
              new OrchestratorMcpFailure({ code: "invalid_request", message: error.detail }),
          ),
        );
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof InboxAgentToolkit.tools>;

export const layer = McpToolAccess.toLayer(InboxAgentToolkit, handlers);
