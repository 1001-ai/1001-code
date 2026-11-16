import { OrchestratorMcpFailure, type ThreadId, voiceAgentToolAllowed } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { McpServer } from "effect/ai";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as VoiceAgent from "../../../voiceAgent/VoiceAgent.ts";
import { isVoiceAgentThread } from "../../../voiceAgent/voiceAgentThread.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { loadCaller } from "../../threadAccess.ts";
import { VoiceAgentToolkit } from "./tools.ts";

/** The calling thread, which must be a voice agent's: the gate hides these tools from others. */
const voiceCaller = loadCaller().pipe(
  Effect.flatMap(({ caller }) =>
    caller === undefined || !isVoiceAgentThread(caller)
      ? Effect.fail(
          new OrchestratorMcpFailure({
            code: "capability_denied",
            message: "Only the voice agent can use this tool.",
          }),
        )
      : Effect.succeed({ threadId: caller.id, projectId: caller.projectId }),
  ),
);

const toMcpFailure = (error: VoiceAgent.VoiceAgentToolError) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message: error.detail });

const handlers = {
  voice_board: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const caller = yield* voiceCaller;
      const voiceAgent = yield* VoiceAgent.VoiceAgent;
      return yield* voiceAgent.board(caller, input).pipe(Effect.mapError(toMcpFailure));
    }),
  ),
  voice_send_message: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const caller = yield* voiceCaller;
      const voiceAgent = yield* VoiceAgent.VoiceAgent;
      return yield* voiceAgent.sendMessage(caller, input).pipe(Effect.mapError(toMcpFailure));
    }),
  ),
  voice_show_media: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const caller = yield* voiceCaller;
      const voiceAgent = yield* VoiceAgent.VoiceAgent;
      return yield* voiceAgent.showMedia(caller, input).pipe(Effect.mapError(toMcpFailure));
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof VoiceAgentToolkit.tools>;

export const layer = McpToolAccess.toLayer(VoiceAgentToolkit, handlers);

/**
 * The check behind T3's MCP server for every tool, on lists and on calls: a voice agent thread
 * gets its own tools and no others, and no other caller gets the voice agent's. A thread that
 * cannot be read gets nothing, so a failed read never opens every tool to a voice agent.
 */
export const makeToolGate = Effect.gen(function* () {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  // A thread's kind never changes, so one read a thread is enough.
  const kinds = new Map<ThreadId, boolean>();
  // Untraced: it runs once per tool on every list request.
  return Effect.fnUntraced(function* ({ method, target }: McpServer.MiddlewareOptions) {
    if (method !== "tools/list" && method !== "tools/call") return true;
    const scope = yield* Effect.serviceOption(McpInvocationContext.McpInvocationContext);
    const threadId = Option.getOrUndefined(scope)?.thread?.threadId;
    if (threadId === undefined) return voiceAgentToolAllowed(target, false);
    let voiceAgent = kinds.get(threadId);
    if (voiceAgent === undefined) {
      const shell = yield* threads.getThreadShell(threadId).pipe(Effect.orElseSucceed(() => null));
      if (shell === null) return false;
      voiceAgent = isVoiceAgentThread(shell);
      kinds.set(threadId, voiceAgent);
      if (kinds.size > 2_000) kinds.delete(kinds.keys().next().value!);
    }
    return voiceAgentToolAllowed(target, voiceAgent);
  });
});
