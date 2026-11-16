import { create } from "zustand";

import {
  LAMP_VOICE_SILENT,
  lampListeningBegan,
  lampSpeechBegan,
  lampSpeechInterrupted,
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
  queue: (text: string) => useLampVoiceStore.setState(lampSpeechQueued(text), true),
  began: () => useLampVoiceStore.setState(lampSpeechBegan),
  progressed: (progress: LampSpeechProgress) =>
    useLampVoiceStore.setState((session) => lampSpeechProgressed(session, progress)),
  silenced: () => useLampVoiceStore.setState(lampSpeechSilenced),
  interrupted: () => useLampVoiceStore.setState(lampSpeechInterrupted),
  listening: () => useLampVoiceStore.setState(lampListeningBegan),
  heard: (transcript: string) =>
    useLampVoiceStore.setState((session) => lampUserHeard(session, transcript)),
};

export function useLampVoiceSession(): LampVoiceSession {
  return useLampVoiceStore();
}

/** What the agent says when nothing is queued. A stub: the agent's own words replace it. */
export function nextLampSpeech(): string {
  return "Nothing new to report. What do you want to build?";
}
