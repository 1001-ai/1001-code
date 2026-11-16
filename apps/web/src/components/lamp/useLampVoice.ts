import { useAtomValue } from "@effect/atom-react";
import {
  type EnvironmentId,
  type ResolvedKeybindingRule,
  type ThreadId,
  VOICE_AGENT_NOTHING_NEW_LINE,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useLayoutEffect, useRef, useState } from "react";

import { useStableCallback } from "~/hooks/useStableCallback";

import { useClientSettings } from "../../hooks/useSettings";
import { useDictationShortcut } from "../../speech/useDictationShortcut";
import { useEnvironmentSpeechInput } from "../../speech/useEnvironmentSpeechInput";
import { primaryServerKeybindingsAtom } from "../../state/server";
import {
  LAMP_AGENT_FEED_EMPTY,
  NO_LAMP_SAYS,
  lampSaySettled,
  lampSayStarted,
  lampSpokenOver,
  nextLampSpeech,
  type LampAnswer,
  type LampSays,
} from "./lampAgent.logic";
import { openLampAudio, suspendLampAudio } from "./lampAudio";
import { closeLampLayer, lampLayerHoldsKeyboard } from "./lampLayer.state";
import {
  lampStatus,
  lampTalk,
  lampVoiceReadiness,
  type LampInterruption,
  type LampSpeech,
  type LampVoiceReadiness,
} from "./lampSpeech.logic";
import { lampVoice, useLampVoiceSession } from "./lampVoice.state";
import { useLampAgent } from "./useLampAgent";
import { useLampSpeaker } from "./useLampSpeaker";

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

const NOT_HEARD = "The voice agent did not get that. Say it again.";
const VOICE_FAILED = "The downloaded voice could not be used. The system voice speaks instead.";

export interface LampVoiceNotice {
  readonly text: string;
  readonly action?: { readonly label: string; readonly run: () => void };
}

const joined = (...parts: ReadonlyArray<string>) => parts.filter((part) => part !== "").join(" ");

/**
 * The layer's voice: it says the agent's answer as it streams in, a few sentences at a time,
 * and listens while Space is held, with the capture and transcription that dictation into the
 * prompt box uses. What the user says goes to the agent, with where they cut it off.
 */
export function useLampVoice(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly threadKey: string;
  readonly closing: boolean;
  readonly openDurationMs: () => number;
}) {
  const session = useLampVoiceSession();
  const navigate = useNavigate();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const shortcutMode = useClientSettings((settings) => settings.voiceShortcutMode);
  const [triedUnready, setTriedUnready] = useState(false);
  const [notHeard, setNotHeard] = useState(false);
  // True once the layer has opened: nothing is said over its opening.
  const [opened, setOpened] = useState(false);
  const agent = useLampAgent(input);
  const voices = useLampSpeaker(input);
  const speaking = useRef<LampSpeech | null>(null);
  const feed = useRef(LAMP_AGENT_FEED_EMPTY);
  // What the voice finished of the answer in progress, and all of it when no voice can speak.
  const saidBefore = useRef("");
  // The line that needs no agent (nothing new, or no agent) is said once for each open.
  const lineSaid = useRef(false);
  // Speech synthesis needs a user gesture: an open without one shows the text as said.
  const byGesture = useRef(true);
  const cutSent = useRef<LampInterruption | null>(null);
  // False from the commit that closes the layer: what a press of Space waits on asks it again.
  const open = useRef(false);
  // Counts the opens: words still on their way when the layer closes change nothing in the next.
  const opens = useRef(0);
  // The user's sends on their way: a failed one is undone only once none is, and not over a later success.
  const says = useRef<LampSays>(NO_LAMP_SAYS);
  // Counts the answers handed back to the voice, which then has something to say again.
  const [handedBack, setHandedBack] = useState(0);

  const tell = useStableCallback(async (text: string) => {
    const opening = opens.current;
    const cut = lampVoice.session().interruption;
    const over = lampSpokenOver(
      { feed: feed.current, saidBefore: saidBefore.current },
      agent.messages,
      // A cut already sent stays in the session until the agent speaks again: it is sent once.
      cut !== null && cut !== cutSent.current ? cut : null,
    );
    cutSent.current = cut;
    // Whatever else arrives of the old answer is not said: the agent picks its point back up itself.
    feed.current = over.answer.feed;
    saidBefore.current = over.answer.saidBefore;
    setNotHeard(false);
    const started = lampSayStarted(says.current);
    says.current = started.says;
    const delivered = await agent.say(text, over.interruption);
    // A send from before the layer was reopened belongs to a tracker that is gone.
    if (opening !== opens.current) return;
    const settled = lampSaySettled(says.current, started.order, delivered, over.undone);
    says.current = settled.says;
    if (!open.current || settled.undo.length === 0) return;
    // The agent was never steered and goes on with its answer, so the voice goes on with it.
    let back: LampAnswer = { feed: feed.current, saidBefore: saidBefore.current };
    for (const undone of settled.undo) back = undone(back);
    feed.current = back.feed;
    saidBefore.current = back.saidBefore;
    setNotHeard(true);
    setHandedBack((count) => count + 1);
  });

  const speech = useEnvironmentSpeechInput({
    environmentId: input.environmentId,
    ownerKey: `lamp:${input.threadKey}`,
    draftText: NO_DRAFT.text,
    // While the layer closes, dictation refuses to start, abandons a recording and drops a late transcript.
    disabled: input.closing,
    readDraft: () => NO_DRAFT,
    commitDraft: (text) => {
      lampVoice.heard(text);
      void tell(text);
    },
  });

  const readiness: LampVoiceReadiness = lampVoiceReadiness({
    available: speech.available,
    destinationChosen: speech.transcriptionEnvironmentId !== null,
    missingModel: speech.status?.supported === true && speech.status.state === "missing-model",
  });

  const talk = useStableCallback(async () => {
    setTriedUnready(readiness !== "ready");
    if (readiness !== "ready") return;
    const current = speaking.current;
    lampVoice.listening();
    await lampTalk({
      open: () => open.current,
      speech: current,
      microphone: speech,
      onInterrupted: () => {
        if (speaking.current === current) speaking.current = null;
        lampVoice.interrupted();
      },
    });
  });
  const stopListening = speech.cancel;

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
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- starts a fresh exchange before an open paints, lets the voice speak once the layer has opened, and stops the voice and the microphone in the commit that closes it
  useLayoutEffect(() => {
    if (closing) return;
    open.current = true;
    opens.current += 1;
    says.current = NO_LAMP_SAYS;
    feed.current = LAMP_AGENT_FEED_EMPTY;
    saidBefore.current = "";
    lineSaid.current = false;
    cutSent.current = null;
    byGesture.current = navigator.userActivation?.isActive ?? true;
    // The downloaded voice needs its audio output opened in the gesture, like speech synthesis.
    if (byGesture.current) openLampAudio();
    const settled = setTimeout(() => setOpened(true), openDurationMs());
    return () => {
      open.current = false;
      clearTimeout(settled);
      setOpened(false);
      setNotHeard(false);
      void speaking.current?.stop("now");
      speaking.current = null;
      suspendLampAudio();
      stopListening();
      // The text stays while the layer fades out.
      lampVoice.silenced();
    };
  }, [closing, openDurationMs, stopListening]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- ends the exchange when the layer unmounts, in the layout phase so it runs before another layer's open in the same commit
  useLayoutEffect(() => lampVoice.ended, []);

  const listening = speech.state.phase !== "idle" && speech.state.phase !== "error";
  const { link, messages } = agent;
  const { speaker } = voices;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- hands the voice the next sentences of the agent's streamed answer whenever it is free, before a paint could show it idle: the speech synthesis is outside React
  useLayoutEffect(() => {
    if (!opened || closing || listening || session.speaking || speaking.current !== null) return;
    // A text is with the voice and not audible yet.
    if (session.preparing !== null) return;
    // Which voice speaks is known once the environment's voice catalog has answered.
    if (byGesture.current && speaker === null) return;
    let text: string | null = null;
    if (!lineSaid.current && link.status !== "opening") {
      lineSaid.current = true;
      if (link.status === "unavailable") text = link.message;
      else if (link.update === "nothing-new") text = VOICE_AGENT_NOTHING_NEW_LINE;
    }
    if (text === null) {
      const next = nextLampSpeech(feed.current, messages);
      if (next === null) return;
      feed.current = next.feed;
      text = next.text;
    }
    const said = text;
    if (!byGesture.current || speaker === null) {
      // No voice: everything written so far shows at once, and all of it counts as said.
      let shown = joined(saidBefore.current, said);
      for (
        let next = nextLampSpeech(feed.current, messages);
        next !== null;
        next = nextLampSpeech(feed.current, messages)
      ) {
        feed.current = next.feed;
        shown = joined(shown, next.text);
      }
      saidBefore.current = shown;
      lampVoice.queue(shown);
      lampVoice.progressed({ sentenceIndex: 0, word: null, done: true });
      return;
    }
    // The captions and "Speaking" start with the voice, which a voice model may take seconds to make.
    lampVoice.preparing(said);
    let audible = false;
    const current: LampSpeech = speaker.speak(said, (progress) => {
      if (!audible) {
        audible = true;
        lampVoice.queue(said);
        lampVoice.began();
      }
      if (progress.done) {
        if (speaking.current === current) speaking.current = null;
        saidBefore.current = joined(saidBefore.current, said);
      }
      lampVoice.progressed(progress);
    });
    speaking.current = current;
  }, [
    opened,
    closing,
    listening,
    session.speaking,
    session.preparing,
    speaker,
    link,
    messages,
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- An answer handed back to the voice changes nothing else here, so the count runs this again.
    handedBack,
  ]);

  const voiceSettings = {
    label: "Voice settings",
    run: () => void navigate({ to: "/settings/voice" }),
  };
  // Starting unready opens the setup dictation already has: Voice settings, or the model download.
  const setUp = { label: "Set up voice input", run: () => void speech.start() };
  const notice: LampVoiceNotice | null =
    speech.state.phase === "error"
      ? { text: speech.state.error ?? "Voice input failed.", action: voiceSettings }
      : notHeard
        ? { text: link.status === "unavailable" ? link.message : NOT_HEARD }
        : !triedUnready || readiness === "ready"
          ? null
          : readiness === "not-set-up"
            ? { text: "Voice input is not set up.", action: setUp }
            : readiness === "missing-model"
              ? { text: "No dictation model is installed.", action: setUp }
              : { text: "Voice input is not available here.", action: voiceSettings };

  return {
    session,
    status: lampStatus({
      speaking: session.speaking,
      voicePhase: speech.state.phase,
      thinking: agent.working || session.preparing !== null,
    }),
    speech,
    notice,
    /** One line for the rest of a conversation in which the downloaded voice failed. */
    voiceFailed: voices.failed ? VOICE_FAILED : null,
    /** Opens the speech output settings, offered while the user has picked no voice. */
    chooseVoice: voices.offerSettings
      ? () => {
          // Settings draw over the chat: the agent would talk on under them, and over a voice sample.
          closeLampLayer();
          void navigate({ to: "/settings/voice", hash: "voice-output" });
        }
      : null,
    /** Whether Space is held to talk, or pressed once to start and once to finish. */
    holdToTalk: shortcutMode !== "toggle",
  };
}
