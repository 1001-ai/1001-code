import { useAtomValue } from "@effect/atom-react";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import {
  type EnvironmentId,
  type ThreadId,
  type VoiceAgentState,
  type VoiceAgentTranscript,
  WS_METHODS,
} from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";

// A chat's closed voice conversations and the screenshots the agent is showing: every client of
// the server sees the same, since both live there.
const voiceAgentSubscription = createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
  label: "environment-data:voice-agent",
  tag: WS_METHODS.voiceAgentSubscribe,
  idleTtlMs: 30_000,
});

export const voiceAgentOpen = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:voice-agent:open",
  tag: WS_METHODS.voiceAgentOpen,
});

export const voiceAgentSay = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:voice-agent:say",
  tag: WS_METHODS.voiceAgentSay,
});

export const voiceAgentClose = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:voice-agent:close",
  tag: WS_METHODS.voiceAgentClose,
});

export const voiceAgentMediaStep = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:voice-agent:media-step",
  tag: WS_METHODS.voiceAgentMediaStep,
});

// A closed conversation does not change, so its transcript is read once.
const voiceAgentTranscriptQuery = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:voice-agent:transcript",
  tag: WS_METHODS.voiceAgentTranscript,
  idleTtlMs: 60_000,
  staleTimeMs: 10 * 60_000,
});

const EMPTY_STATE_ATOM = Atom.make(AsyncResult.initial<VoiceAgentState, never>()).pipe(
  Atom.withLabel("web-voice-agent:empty"),
);

/** What a chat shows of its voice agent; null until the server answers, or on one without it. */
export function useVoiceAgentState(
  environmentId: EnvironmentId | null,
  threadId: ThreadId | null,
): VoiceAgentState | null {
  const result = useAtomValue(
    environmentId === null || threadId === null
      ? EMPTY_STATE_ATOM
      : voiceAgentSubscription({ environmentId, input: { threadId } }),
  );
  return AsyncResult.getOrElse(result, () => null);
}

export function useVoiceAgentTranscript(
  environmentId: EnvironmentId,
  sessionId: string,
): AsyncResult.AsyncResult<VoiceAgentTranscript, unknown> {
  return useAtomValue(voiceAgentTranscriptQuery({ environmentId, input: { sessionId } }));
}
