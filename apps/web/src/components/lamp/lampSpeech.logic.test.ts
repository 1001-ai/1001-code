import { describe, expect, it } from "vite-plus/test";

import {
  captionParts,
  estimateWordStartsMs,
  lampListeningBegan,
  lampSpeechBegan,
  lampSpeechInterrupted,
  lampSpeechProgressed,
  lampSpeechQueued,
  lampStatus,
  lampTalk,
  lampUserHeard,
  lampVoiceReadiness,
  splitSentences,
  stoppedAfterLine,
  wordIndexAtChar,
  wordIndexAtElapsed,
  type LampVoiceSession,
} from "./lampSpeech.logic";

const TEXT = "Nothing new to report. What do you want to build?";
const sentencesOf = (text: string) =>
  splitSentences(text).map((sentence) => text.slice(sentence.start, sentence.end));
const wordsOf = (text: string, index: number) =>
  splitSentences(text)[index]!.words.map((word) => text.slice(word.start, word.end));

/** A session that is speaking `TEXT` and has reached the given word of the given sentence. */
function speakingAt(sentenceIndex: number, wordIndex: number): LampVoiceSession {
  const session = lampSpeechBegan(lampSpeechQueued(TEXT));
  const word = session.said!.sentences[sentenceIndex]!.words[wordIndex]!;
  return lampSpeechProgressed(session, { sentenceIndex, word, done: false });
}

/** A press of Space the test drives: a voice that stops, and a microphone that starts, when told. */
function pressing(input: { readonly open: boolean; readonly speaking: boolean }) {
  const events: string[] = [];
  let open = input.open;
  let voiceStopped = () => {};
  let microphoneStarted = () => {};
  const quiet = new Promise<void>((resolve) => (voiceStopped = resolve));
  const started = new Promise<void>((resolve) => (microphoneStarted = resolve));
  const stop = (when: string) => {
    events.push(`voice stops ${when}`);
    return quiet;
  };
  const talking = lampTalk({
    open: () => open,
    speech: input.speaking ? { stop } : null,
    microphone: {
      start: () => {
        events.push("microphone starts");
        return started;
      },
      cancel: () => void events.push("microphone cancelled"),
    },
    onInterrupted: () => void events.push("interruption recorded"),
  });
  return {
    events,
    talking,
    close: () => void (open = false),
    voiceStopped,
    microphoneStarted,
  };
}

describe("lamp speech", () => {
  it("splits a text into sentences and their words, by offsets into the text", () => {
    expect(sentencesOf(TEXT)).toEqual(["Nothing new to report.", "What do you want to build?"]);
    expect(wordsOf(TEXT, 1)).toEqual(["What", "do", "you", "want", "to", "build?"]);
    expect(sentencesOf('He said "stop." Then: go!\n\nVersion 2.5 is out')).toEqual([
      'He said "stop."',
      "Then: go!",
      "Version 2.5 is out",
    ]);
    expect(sentencesOf("  ")).toEqual([]);
  });

  it("finds the word a voice's boundary names, counted from the start of its sentence", () => {
    const second = splitSentences(TEXT)[1]!;
    expect(wordIndexAtChar(second, 0)).toBe(0);
    expect(wordIndexAtChar(second, 6)).toBe(1);
    // A voice that points at the space before a word means the word after it.
    expect(wordIndexAtChar(second, 4)).toBe(1);
    expect(wordIndexAtChar(second, 999)).toBe(5);
  });

  it("estimates the word from the time into a sentence when the voice names none", () => {
    const first = splitSentences(TEXT)[0]!;
    const starts = estimateWordStartsMs(TEXT, first);
    expect(starts).toEqual([0, 420, 600, 720]);
    expect(wordIndexAtElapsed(starts, -1)).toBe(-1);
    expect(wordIndexAtElapsed(starts, 0)).toBe(0);
    expect(wordIndexAtElapsed(starts, 599)).toBe(1);
    expect(wordIndexAtElapsed(starts, 5_000)).toBe(3);
    // A faster voice reaches each word sooner, and a clause ends in a pause.
    expect(estimateWordStartsMs(TEXT, first, 2)).toEqual([0, 210, 300, 360]);
    const clause = "Wait, go";
    expect(estimateWordStartsMs(clause, splitSentences(clause)[0]!)).toEqual([0, 480]);
  });

  it("colours the text as said, being said and to come", () => {
    const queued = lampSpeechQueued(TEXT);
    expect(captionParts(queued.said!)).toEqual({ spoken: "", current: "", upcoming: TEXT });
    expect(captionParts(speakingAt(1, 1).said!)).toEqual({
      spoken: "Nothing new to report. What ",
      current: "do",
      upcoming: " you want to build?",
    });
    const done = lampSpeechProgressed(queued, { sentenceIndex: 1, word: null, done: true });
    expect(captionParts(done.said!)).toEqual({ spoken: TEXT, current: "", upcoming: "" });
    expect(done.speaking).toBe(false);
  });

  it("records where the user cut in, then what they said", () => {
    const interrupted = lampSpeechInterrupted(speakingAt(1, 1));
    expect(interrupted.speaking).toBe(false);
    expect(interrupted.interruption).toEqual({
      spoken: "Nothing new to report. What do",
      unspoken: "you want to build?",
      transcript: null,
    });
    // The word in progress counts as said, and nothing is highlighted any more.
    expect(captionParts(interrupted.said!)).toEqual({
      spoken: "Nothing new to report. What do",
      current: "",
      upcoming: " you want to build?",
    });
    expect(stoppedAfterLine(interrupted.interruption!)).toBe('Stopped after "…to report. What do"');

    const heard = lampUserHeard(lampListeningBegan(interrupted), "Build a parser");
    expect(heard.heard).toBe("Build a parser");
    expect(heard.interruption?.transcript).toBe("Build a parser");
    // What the user says later does not rewrite what they said at the interruption.
    const again = lampUserHeard(lampListeningBegan(heard), "And tests");
    expect(again.heard).toBe("And tests");
    expect(again.interruption?.transcript).toBe("Build a parser");
    // Progress that arrives after the stop does not move the text on.
    expect(lampSpeechProgressed(interrupted, { sentenceIndex: 1, word: null, done: true })).toBe(
      interrupted,
    );
  });

  it("records no interruption when the agent had finished, and all of it before it began", () => {
    const done = lampSpeechProgressed(lampSpeechBegan(lampSpeechQueued(TEXT)), {
      sentenceIndex: 1,
      word: null,
      done: true,
    });
    expect(lampSpeechInterrupted(done).interruption).toBeNull();

    const early = lampSpeechInterrupted(lampSpeechQueued(TEXT));
    expect(early.interruption).toEqual({ spoken: "", unspoken: TEXT, transcript: null });
    expect(stoppedAfterLine(early.interruption!)).toBe("Stopped before the first word.");
    // Between sentences, the sentences already said are the spoken part.
    const between = lampSpeechProgressed(lampSpeechBegan(lampSpeechQueued(TEXT)), {
      sentenceIndex: 1,
      word: null,
      done: false,
    });
    expect(lampSpeechInterrupted(between).interruption?.spoken).toBe("Nothing new to report.");
    expect(stoppedAfterLine(lampSpeechInterrupted(between).interruption!)).toBe(
      'Stopped after "Nothing new to report."',
    );
  });

  it("starts a new exchange with each text the agent says", () => {
    const heard = lampUserHeard(lampSpeechInterrupted(speakingAt(0, 2)), "Stop");
    const next = lampSpeechQueued("Done.");
    expect(heard.interruption).not.toBeNull();
    expect(next.interruption).toBeNull();
    expect(next.heard).toBeNull();
  });

  it("listens from the press, while the agent finishes the word it is on", async () => {
    const press = pressing({ open: true, speaking: true });
    // Capture does not wait for the voice, so the user's first words are kept.
    expect(press.events).toEqual(["voice stops after-word", "microphone starts"]);
    press.microphoneStarted();
    press.voiceStopped();
    await press.talking;
    expect(press.events).toEqual([
      "voice stops after-word",
      "microphone starts",
      "interruption recorded",
    ]);

    const quiet = pressing({ open: true, speaking: false });
    quiet.microphoneStarted();
    await quiet.talking;
    expect(quiet.events).toEqual(["microphone starts"]);
  });

  it("opens no microphone once the layer has closed, and cancels one that was starting", async () => {
    const closed = pressing({ open: false, speaking: true });
    expect(closed.events).toEqual([]);

    const closing = pressing({ open: true, speaking: true });
    closing.close();
    closing.microphoneStarted();
    closing.voiceStopped();
    await closing.talking;
    expect(closing.events).toEqual([
      "voice stops after-word",
      "microphone starts",
      "microphone cancelled",
    ]);
  });

  it("is listening until the user's words are transcribed, and speaking only while it talks", () => {
    expect(lampStatus({ speaking: false, voicePhase: "idle" })).toBe("idle");
    expect(lampStatus({ speaking: true, voicePhase: "idle" })).toBe("speaking");
    expect(lampStatus({ speaking: true, voicePhase: "preparing" })).toBe("listening");
    expect(lampStatus({ speaking: false, voicePhase: "transcribing" })).toBe("listening");
    expect(lampStatus({ speaking: false, voicePhase: "error" })).toBe("idle");
  });

  it("says why dictation cannot start", () => {
    const ready = { available: true, destinationChosen: true, missingModel: false };
    expect(lampVoiceReadiness(ready)).toBe("ready");
    expect(lampVoiceReadiness({ ...ready, destinationChosen: false })).toBe("not-set-up");
    expect(lampVoiceReadiness({ ...ready, missingModel: true })).toBe("missing-model");
    expect(lampVoiceReadiness({ ...ready, available: false })).toBe("unavailable");
  });
});
