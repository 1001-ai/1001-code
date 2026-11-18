import { type LockedAgentKind, type ThreadId, lockedAgentToolAllowed } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { type McpServer, McpSchema } from "effect/ai";

import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import { inboxSendRefusal } from "../inboxAgent/inboxAgentSend.ts";
import { isInboxThread } from "../inboxAgent/inboxAgentThreads.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { lockedAgentKindOf } from "./lockedAgentKind.ts";

/**
 * The check behind T3's MCP server for every tool, on lists and calls: a locked agent thread gets
 * its own kind's tools only, no other caller gets the voice agent's, and a thread that cannot be
 * read gets nothing. An Inbox's `t3_thread_send` also needs `inboxSendRefusal` to allow it.
 */
export const makeToolGate = Effect.gen(function* () {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  // A voice agent thread's kind never changes, so one read a thread is enough.
  const kinds = new Map<ThreadId, LockedAgentKind | null>();
  // Untraced: it runs once per tool on every list request.
  return Effect.fnUntraced(function* ({ method, target, payload }: McpServer.MiddlewareOptions) {
    if (method !== "tools/list" && method !== "tools/call") return true;
    const scope = Option.getOrUndefined(
      yield* Effect.serviceOption(McpInvocationContext.McpInvocationContext),
    );
    const threadId = scope?.thread?.threadId;
    if (scope === undefined || threadId === undefined) return lockedAgentToolAllowed(target, null);
    if (isInboxThread(threadId)) {
      if (method === "tools/call" && target === "t3_thread_send") {
        const refusal = yield* inboxSendRefusal(threads, {
          inboxThreadId: threadId,
          environmentId: scope.environmentId,
          payload,
        });
        if (refusal !== null) return yield* new McpSchema.InvalidRequest({ message: refusal });
      }
      return lockedAgentToolAllowed(target, "inbox");
    }
    let kind = kinds.get(threadId);
    if (kind === undefined) {
      const shell = yield* threads.getThreadShell(threadId).pipe(Effect.orElseSucceed(() => null));
      if (shell === null) return false;
      kind = lockedAgentKindOf(shell);
      kinds.set(threadId, kind);
      if (kinds.size > 2_000) kinds.delete(kinds.keys().next().value!);
    }
    return lockedAgentToolAllowed(target, kind);
  });
});
