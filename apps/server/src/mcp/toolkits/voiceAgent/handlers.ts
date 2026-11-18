import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as VoiceAgent from "../../../voiceAgent/VoiceAgent.ts";
import { isVoiceAgentThread } from "../../../voiceAgent/voiceAgentThread.ts";
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
