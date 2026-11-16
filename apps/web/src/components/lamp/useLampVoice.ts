import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ResolvedKeybindingRule } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

import { useStableCallback } from "~/hooks/useStableCallback";

import { useClientSettings } from "../../hooks/useSettings";
import { useDictationShortcut } from "../../speech/useDictationShortcut";
import { useEnvironmentSpeechInput } from "../../speech/useEnvironmentSpeechInput";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { lampLayerHoldsKeyboard } from "./lampLayer.state";
import { lampSpeaker } from "./lampSpeaker";
import {
  lampStatus,
  lampVoiceReadiness,
  type LampSpeech,
  type LampVoiceReadiness,
} from "./lampSpeech.logic";
import { lampVoice, nextLampSpeech, useLampVoiceSession } from "./lampVoice.state";

// Space talks to the layer through the dictation shortcut's own hold handling.
const SPACE_TALKS: ResolvedKeybindingRule = {
  command: "composer.dictation",
  shortcut: {
    key: " ",
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    modKey: false,
  },
};

// The user's words go to the layer, not into a draft: the draft dictation writes to stays empty.
const NO_DRAFT = { text: "", selection: { start: 0, end: 0 } };

export interface LampVoiceNotice {
  readonly text: string;
  readonly action: { readonly label: string; readonly run: () => void };
}

/**
 * The layer's voice: it says the agent's text once the layer has opened, and listens while
 * Space is held, with the capture and transcription that dictation into the prompt box uses.
 */
export function useLampVoice(input: {
  readonly environmentId: EnvironmentId;
  readonly threadKey: string;
  readonly closing: boolean;
  readonly openDurationMs: () => number;
}) {
  const session = useLampVoiceSession();
  const navigate = useNavigate();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const shortcutMode = useClientSettings((settings) => settings.voiceShortcutMode);
  const [triedUnready, setTriedUnready] = useState(false);
  const speech = useEnvironmentSpeechInput({
    environmentId: input.environmentId,
    ownerKey: `lamp:${input.threadKey}`,
    draftText: NO_DRAFT.text,
    readDraft: () => NO_DRAFT,
    commitDraft: (text) => lampVoice.heard(text),
  });
  const speaking = useRef<LampSpeech | null>(null);
  const greeting = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attempt = useRef(0);

  const readiness: LampVoiceReadiness = lampVoiceReadiness({
    available: speech.available,
    destinationChosen: speech.transcriptionEnvironmentId !== null,
    missingModel: speech.status?.supported === true && speech.status.state === "missing-model",
  });

  const talk = useStableCallback(async () => {
    const mine = ++attempt.current;
    setTriedUnready(readiness !== "ready");
    if (readiness !== "ready") return;
    if (greeting.current !== null) {
      clearTimeout(greeting.current);
      greeting.current = null;
      lampVoice.interrupted();
    }
    const current = speaking.current;
    if (current) {
      await current.stop("after-word");
      if (speaking.current === current) speaking.current = null;
      lampVoice.interrupted();
      if (mine !== attempt.current) return;
    }
    lampVoice.listening();
    await speech.start();
  });
  const stopListening = useStableCallback(() => {
    attempt.current += 1;
    speech.cancel();
  });

  useDictationShortcut({
    keybindings: [...keybindings, SPACE_TALKS],
    speech: {
      available: true,
      state: speech.state,
      start: talk,
      stop: speech.stop,
      cancel: stopListening,
    },
    disabled: input.closing,
    terminalOpen: false,
    modelPickerOpen: false,
    ownsFocus: lampLayerHoldsKeyboard,
  });

  const { closing, openDurationMs } = input;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- speaks once the layer has opened, and stops the voice and the microphone when it closes
  useEffect(() => {
    if (closing) return;
    const text = nextLampSpeech();
    lampVoice.queue(text);
    // Speech synthesis needs a user gesture: an open without one shows the text as said.
    const byGesture = navigator.userActivation?.isActive ?? true;
    greeting.current = setTimeout(() => {
      greeting.current = null;
      if (!byGesture) {
        lampVoice.progressed({ sentenceIndex: 0, word: null, done: true });
        return;
      }
      lampVoice.began();
      speaking.current = lampSpeaker.speak(text, lampVoice.progressed);
    }, openDurationMs());
    return () => {
      if (greeting.current !== null) clearTimeout(greeting.current);
      greeting.current = null;
      void speaking.current?.stop("now");
      speaking.current = null;
      stopListening();
      lampVoice.silenced();
    };
  }, [closing, openDurationMs, stopListening]);

  const voiceSettings = {
    label: "Voice settings",
    run: () => void navigate({ to: "/settings/voice" }),
  };
  // Starting unready opens the setup dictation already has: Voice settings, or the model download.
  const setUp = { label: "Set up voice input", run: () => void speech.start() };
  const notice: LampVoiceNotice | null =
    speech.state.phase === "error"
      ? { text: speech.state.error ?? "Voice input failed.", action: voiceSettings }
      : !triedUnready || readiness === "ready"
        ? null
        : readiness === "not-set-up"
          ? { text: "Voice input is not set up.", action: setUp }
          : readiness === "missing-model"
            ? { text: "No dictation model is installed.", action: setUp }
            : { text: "Voice input is not available here.", action: voiceSettings };

  return {
    session,
    status: lampStatus({ speaking: session.speaking, voicePhase: speech.state.phase }),
    speech,
    notice,
    /** Whether Space is held to talk, or pressed once to start and once to finish. */
    holdToTalk: shortcutMode !== "toggle",
  };
}
