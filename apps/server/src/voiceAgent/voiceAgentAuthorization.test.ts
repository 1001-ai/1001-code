import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  ThreadId,
  WS_METHODS,
  WsRpcGroup,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as RpcTest from "effect/rpc/RpcTest";

import * as RpcAuthorization from "../auth/RpcAuthorization.ts";

const VOICE_AGENT_METHODS = [
  WS_METHODS.voiceAgentSubscribe,
  WS_METHODS.voiceAgentOpen,
  WS_METHODS.voiceAgentSay,
  WS_METHODS.voiceAgentClose,
  WS_METHODS.voiceAgentMediaStep,
  WS_METHODS.voiceAgentTranscript,
] as const;
type VoiceAgentMethod = (typeof VOICE_AGENT_METHODS)[number];

const CHAT = ThreadId.make("chat-1");
const SESSION = "v-1";

const group = WsRpcGroup.omit(
  ...[...WsRpcGroup.requests.keys()].filter(
    (tag): tag is Exclude<keyof typeof RpcAuthorization.RPC_REQUIRED_SCOPES, VoiceAgentMethod> =>
      !(VOICE_AGENT_METHODS as ReadonlyArray<string>).includes(tag),
  ),
);

const clientWith = (scopes: Parameters<typeof RpcAuthorization.layer>[0], handled: Array<string>) =>
  RpcTest.makeClient(group).pipe(
    Effect.provide(
      Layer.mergeAll(
        group.toLayerHandler(WS_METHODS.voiceAgentSubscribe, () => {
          handled.push("subscribe");
          return Stream.make({ sessions: [], media: null });
        }),
        group.toLayerHandler(WS_METHODS.voiceAgentOpen, () =>
          Effect.sync(() => {
            handled.push("open");
            return { status: "unavailable" as const, message: "No Claude." };
          }),
        ),
        group.toLayerHandler(WS_METHODS.voiceAgentSay, () =>
          Effect.sync(() => {
            handled.push("say");
            return { delivery: "started" as const };
          }),
        ),
        group.toLayerHandler(WS_METHODS.voiceAgentClose, () =>
          Effect.sync(() => void handled.push("close")),
        ),
        group.toLayerHandler(WS_METHODS.voiceAgentMediaStep, () =>
          Effect.sync(() => void handled.push("mediaStep")),
        ),
        group.toLayerHandler(WS_METHODS.voiceAgentTranscript, () =>
          Effect.sync(() => {
            handled.push("transcript");
            return { sessionId: SESSION, openedAt: "", closedAt: null, turns: [] };
          }),
        ),
        RpcAuthorization.layer(scopes),
      ),
    ),
  );

it.effect(
  "lets a reader see a chat's voice conversations, and only an operator talk to the agent",
  () =>
    Effect.gen(function* () {
      const handled: Array<string> = [];
      const reader = yield* clientWith([AuthOrchestrationReadScope], handled);
      yield* reader[WS_METHODS.voiceAgentSubscribe]({ threadId: CHAT }).pipe(Stream.runDrain);
      yield* reader[WS_METHODS.voiceAgentTranscript]({ sessionId: SESSION });
      for (const refused of [
        reader[WS_METHODS.voiceAgentOpen]({ threadId: CHAT }),
        reader[WS_METHODS.voiceAgentSay]({ sessionId: SESSION, text: "Hello." }),
        reader[WS_METHODS.voiceAgentClose]({ sessionId: SESSION }),
        reader[WS_METHODS.voiceAgentMediaStep]({ sessionId: SESSION, index: 0 }),
      ]) {
        expect(yield* refused.pipe(Effect.flip)).toMatchObject({
          requiredPermission: AuthOrchestrationOperateScope,
        });
      }
      expect(handled).toEqual(["subscribe", "transcript"]);

      const operator = yield* clientWith(
        [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
        handled,
      );
      yield* operator[WS_METHODS.voiceAgentOpen]({ threadId: CHAT });
      yield* operator[WS_METHODS.voiceAgentSay]({ sessionId: SESSION, text: "Hello." });
      yield* operator[WS_METHODS.voiceAgentMediaStep]({ sessionId: SESSION, index: null });
      yield* operator[WS_METHODS.voiceAgentClose]({ sessionId: SESSION });
      expect(handled.slice(2)).toEqual(["open", "say", "mediaStep", "close"]);

      // What the user said is capped before it reaches the handler.
      const tooLong = yield* operator[WS_METHODS.voiceAgentSay]({
        sessionId: SESSION,
        text: "x".repeat(4_001),
      }).pipe(Effect.exit);
      expect(tooLong._tag).toBe("Failure");
      expect(handled).toHaveLength(6);
    }).pipe(Effect.scoped),
);
