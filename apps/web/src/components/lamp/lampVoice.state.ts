import { useEffect } from "react";
import { create } from "zustand";

import {
  LAMP_VOICE_SILENT,
  lampListeningBegan,
  lampSpeechBegan,
  lampSpeechInterrupted,
  lampSpeechPreparing,
  lampSpeechProgressed,
  lampSpeechQueued,
  lampSpeechSilenced,
  lampUserHeard,
  type LampSpeechProgress,
  type LampVoiceSession,
} from "./lampSpeech.logic";

/**
 * One exchange with the voice agent: what it says and how far it got, where the user cut it
 * off, and what the user said. The agent that answers reads the interruption from here.
 */
const useLampVoiceStore = create<LampVoiceSession>(() => LAMP_VOICE_SILENT);

export const lampVoice = {
  preparing: (text: string) =>
    useLampVoiceStore.setState((session) => lampSpeechPreparing(session, text)),
  queue: (text: string) => useLampVoiceStore.setState(lampSpeechQueued(text), true),
  began: () => useLampVoiceStore.setState(lampSpeechBegan),
  progressed: (progress: LampSpeechProgress) =>
    useLampVoiceStore.setState((session) => lampSpeechProgressed(session, progress)),
  silenced: () => useLampVoiceStore.setState(lampSpeechSilenced),
  interrupted: () => useLampVoiceStore.setState(lampSpeechInterrupted),
  listening: () => useLampVoiceStore.setState(lampListeningBegan),
  heard: (transcript: string) =>
    useLampVoiceStore.setState((session) => lampUserHeard(session, transcript)),
  /** The layer has gone. Nothing of the exchange is left for the next open to show. */
  ended: () => useLampVoiceStore.setState(LAMP_VOICE_SILENT, true),
  session: () => useLampVoiceStore.getState(),
};

export function useLampVoiceSession(): LampVoiceSession {
  return useLampVoiceStore();
}

/** Whether the open layer's agent is thinking, for the lamps outside the layer, such as the button. */
const useLampThinkingStore = create<{ readonly thinking: boolean }>(() => ({ thinking: false }));

export function useLampThinking(): boolean {
  return useLampThinkingStore((state) => state.thinking);
}

export function useShareLampThinking(thinking: boolean): void {
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the button sits outside the layer, so it reads the layer's status from the store
  useEffect(() => {
    useLampThinkingStore.setState({ thinking });
    return () => useLampThinkingStore.setState({ thinking: false });
  }, [thinking]);
}
