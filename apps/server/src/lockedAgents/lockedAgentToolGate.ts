import {
  type LockedAgentKind,
  type ThreadId,
  lockedAgentKind,
  lockedAgentToolAllowed,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { McpServer } from "effect/ai";

import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";

/**
 * The check behind T3's MCP server for every tool, on lists and on calls: a locked agent thread
 * (the voice agent, a project's Inbox) gets its own kind's tools and no others, and no other
 * caller gets the tools only the voice agent has. A thread that cannot be read gets nothing, so
 * a failed read never opens every tool to a locked agent.
 */
export const makeToolGate = Effect.gen(function* () {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  // A thread's kind never changes, so one read a thread is enough.
  const kinds = new Map<ThreadId, LockedAgentKind | null>();
  // Untraced: it runs once per tool on every list request.
  return Effect.fnUntraced(function* ({ method, target }: McpServer.MiddlewareOptions) {
    if (method !== "tools/list" && method !== "tools/call") return true;
    const scope = yield* Effect.serviceOption(McpInvocationContext.McpInvocationContext);
    const threadId = Option.getOrUndefined(scope)?.thread?.threadId;
    if (threadId === undefined) return lockedAgentToolAllowed(target, null);
    let kind = kinds.get(threadId);
    if (kind === undefined) {
      const shell = yield* threads.getThreadShell(threadId).pipe(Effect.orElseSucceed(() => null));
      if (shell === null) return false;
      kind = lockedAgentKind(shell.lineage);
      kinds.set(threadId, kind);
      if (kinds.size > 2_000) kinds.delete(kinds.keys().next().value!);
    }
    return lockedAgentToolAllowed(target, kind);
  });
});
