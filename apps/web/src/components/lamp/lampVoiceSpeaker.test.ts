import { describe, expect, it } from "vite-plus/test";

import {
  lampSpeechBegan,
  lampSpeechInterrupted,
  lampSpeechProgressed,
  lampSpeechQueued,
  type LampSpeaker,
  type LampSpeechProgress,
} from "./lampSpeech.logic";
import {
  createLampVoiceSpeaker,
  type LampAudioOutput,
  type LampVoiceAudio,
  type LampVoiceSource,
} from "./lampVoiceSpeaker";

const TEXT = "One two three. Four five.";
const SAMPLE_RATE = 8_000;
const WORD_MS = 200;

/** A sentence's audio as the environment sends it: every word lasts `wordMs`. */
function audioFor(sentence: string, wordMs = WORD_MS): ReadonlyArray<LampVoiceAudio> {
  const words = [...sentence.matchAll(/\S+/g)].map((match, index) => ({
    start: match.index,
    end: match.index + match[0].length,
    t0Ms: index * wordMs,
    t1Ms: (index + 1) * wordMs,
  }));
  const samples = (words.length * wordMs * SAMPLE_RATE) / 1000;
  return [{ sampleRate: SAMPLE_RATE, words, pcm: new Uint8Array(samples * 2) }];
}

/** A voice model the test drives: each sentence asked for waits until its audio is sent or refused. */
function fakeSource() {
  const asked: Array<{
    readonly sentence: string;
    readonly signal: AbortSignal;
    readonly send: (pieces?: ReadonlyArray<LampVoiceAudio>) => Promise<void>;
    readonly refuse: () => Promise<void>;
  }> = [];
  const source: LampVoiceSource = (sentence, signal) => {
    let resolve: (pieces: ReadonlyArray<LampVoiceAudio>) => void = () => {};
    let reject: (cause: Error) => void = () => {};
    const promise = new Promise<ReadonlyArray<LampVoiceAudio>>((onAudio, onRefused) => {
      resolve = onAudio;
      reject = onRefused;
    });
    asked.push({
      sentence,
      signal,
      // The speaker reacts to the promise first, so it has the audio once these return.
      send: async (pieces = audioFor(sentence)) => {
        resolve(pieces);
        await promise;
      },
      refuse: async () => {
        reject(new Error("refused"));
        await promise.catch(() => undefined);
      },
    });
    return promise;
  };
  return { asked, source };
}

/** An audio output on a clock the test moves. It records what was played, from when, and any cut. */
function fakeAudio() {
  let nowMs = 0;
  let broken = false;
  let due: Array<{ readonly atMs: number; readonly run: () => void }> = [];
  const played: Array<{ readonly at: number; cutAt: number | null }> = [];
  const output: LampAudioOutput = {
    now: () => nowMs / 1000,
    play(_pcm, _sampleRate, at) {
      if (broken) throw new Error("no audio output");
      const piece = { at, cutAt: null as number | null };
      played.push(piece);
      return () => void (piece.cutAt ??= nowMs / 1000);
    },
    at(at, run) {
      const entry = { atMs: Math.round(at * 1000), run };
      due.push(entry);
      return () => void (due = due.filter((other) => other !== entry));
    },
  };
  return {
    output,
    played,
    breakOutput: () => void (broken = true),
    /** Moves the clock on, running what falls due on the way: earliest first, then first asked. */
    advance(ms: number) {
      const untilMs = nowMs + ms;
      const earliest = () =>
        due.reduce<(typeof due)[number] | null>(
          (first, entry) =>
            entry.atMs <= untilMs && (first === null || entry.atMs < first.atMs) ? entry : first,
          null,
        );
      for (let entry = earliest(); entry !== null; entry = earliest()) {
        due = due.filter((other) => other !== entry);
        nowMs = Math.max(nowMs, entry.atMs);
        entry.run();
      }
      nowMs = untilMs;
    },
  };
}

/** The system voice as the fallback: the test sees what it was asked to say and reports for it. */
function fakeFallback() {
  const spoken: Array<{
    readonly text: string;
    readonly report: (progress: LampSpeechProgress) => void;
    readonly stops: string[];
  }> = [];
  const speaker: LampSpeaker = {
    speak(text, onProgress) {
      const stops: string[] = [];
      spoken.push({ text, report: onProgress, stops });
      return { stop: async (when) => void stops.push(when) };
    },
  };
  return { spoken, speaker };
}

function speaking(text = TEXT) {
  const voice = fakeSource();
  const audio = fakeAudio();
  const fallback = fakeFallback();
  const progress: LampSpeechProgress[] = [];
  let failures = 0;
  const speaker = createLampVoiceSpeaker({
    source: voice.source,
    audio: audio.output,
    fallback: fallback.speaker,
    onFailure: () => void (failures += 1),
  });
  const speech = speaker.speak(text, (next) => void progress.push(next));
  const word = () => {
    const range = progress.at(-1)?.word;
    return range ? text.slice(range.start, range.end) : null;
  };
  return {
    asked: voice.asked,
    sentencesAsked: () => voice.asked.map((entry) => entry.sentence),
    audio,
    fallback: fallback.spoken,
    speaker,
    speech,
    progress,
    word,
    failures: () => failures,
  };
}

describe("lamp voice speaker", () => {
  it("starts the captions with the audio and sets each word from its timing", async () => {
    const { asked, sentencesAsked, audio, progress, word } = speaking();
    expect(sentencesAsked()).toEqual(["One two three."]);
    // While the first sentence is made there is nothing to show.
    audio.advance(5_000);
    expect(progress).toEqual([]);

    await asked[0]!.send();
    audio.advance(0);
    expect(progress).toEqual([
      { sentenceIndex: 0, word: null, done: false },
      { sentenceIndex: 0, word: { start: 0, end: 3 }, done: false },
    ]);
    audio.advance(WORD_MS - 1);
    expect(word()).toBe("One");
    audio.advance(1);
    expect(word()).toBe("two");

    // The next sentence arrives while this one plays, and follows it with no gap.
    await asked[1]!.send();
    expect(audio.played.map((piece) => piece.at)).toEqual([5, 5.6]);
    audio.advance(2 * WORD_MS);
    expect(progress.at(-1)).toEqual({
      sentenceIndex: 1,
      word: { start: 15, end: 19 },
      done: false,
    });
    audio.advance(WORD_MS);
    expect(word()).toBe("five.");
    expect(progress.some((entry) => entry.done)).toBe(false);
    audio.advance(WORD_MS);
    expect(progress.at(-1)).toEqual({ sentenceIndex: 1, word: null, done: true });
    expect(audio.played.every((piece) => piece.cutAt === null)).toBe(true);
  });

  it("asks for one sentence ahead, when the sentence before it starts", async () => {
    const { asked, sentencesAsked, audio, word } = speaking("One. Two. Three.");
    await asked[0]!.send();
    expect(sentencesAsked()).toEqual(["One."]);
    audio.advance(0);
    expect(sentencesAsked()).toEqual(["One.", "Two."]);
    // Audio that is ready early is not a reason to ask for more.
    await asked[1]!.send();
    expect(sentencesAsked()).toEqual(["One.", "Two."]);
    audio.advance(WORD_MS);
    expect(word()).toBe("Two.");
    expect(sentencesAsked()).toEqual(["One.", "Two.", "Three."]);

    // A sentence that is late starts when it arrives, and the word before it stays until then.
    audio.advance(1_000);
    expect(word()).toBe("Two.");
    await asked[2]!.send();
    audio.advance(0);
    expect(word()).toBe("Three.");
    expect(audio.played.map((piece) => piece.at)).toEqual([0, 0.2, 1.2]);
  });

  it("lets the word being spoken finish when the user cuts in, then stops the audio and the request", async () => {
    const { asked, audio, speech, progress, word } = speaking();
    await asked[0]!.send();
    audio.advance(WORD_MS + 50);
    expect(word()).toBe("two");
    const stopping = speech.stop("after-word");
    audio.advance(WORD_MS - 51);
    expect(audio.played[0]!.cutAt).toBeNull();
    expect(asked[1]!.signal.aborted).toBe(false);

    audio.advance(1);
    await stopping;
    expect(audio.played[0]!.cutAt).toBe(0.4);
    expect(asked[1]!.signal.aborted).toBe(true);
    // The word that would have started is never reported, and neither is anything after it.
    await asked[1]!.send();
    audio.advance(5_000);
    expect(word()).toBe("two");
    expect(audio.played).toHaveLength(1);
    expect(progress.some((entry) => entry.done)).toBe(false);

    const session = progress.reduce(lampSpeechProgressed, lampSpeechBegan(lampSpeechQueued(TEXT)));
    expect(lampSpeechInterrupted(session).interruption).toEqual({
      spoken: "One two",
      unspoken: "three. Four five.",
      transcript: null,
    });
  });

  it("stops within the grace period in a long word, and cuts a sentence already scheduled", async () => {
    const { asked, audio, speech, word } = speaking("Supercalifragilistic. Word.");
    await asked[0]!.send(audioFor("Supercalifragilistic.", 1_000));
    audio.advance(100);
    await asked[1]!.send();
    const stopping = speech.stop("after-word");
    audio.advance(299);
    expect(audio.played[0]!.cutAt).toBeNull();
    audio.advance(1);
    await stopping;
    expect(audio.played.map((piece) => piece.cutAt)).toEqual([0.4, 0.4]);
    audio.advance(5_000);
    expect(word()).toBe("Supercalifragilistic.");
  });

  it("stops at once on request, and when no word is being spoken yet", async () => {
    const closed = speaking();
    await closed.asked[0]!.send();
    closed.audio.advance(50);
    await closed.speech.stop("now");
    expect(closed.audio.played[0]!.cutAt).toBe(0.05);
    expect(closed.asked[1]!.signal.aborted).toBe(true);
    closed.audio.advance(5_000);
    expect(closed.word()).toBe("One");

    // The first audio is still being made: there is no word to let finish.
    const early = speaking();
    await early.speech.stop("after-word");
    expect(early.asked[0]!.signal.aborted).toBe(true);
    await early.asked[0]!.send();
    early.audio.advance(5_000);
    expect(early.progress).toEqual([]);
    expect(early.audio.played).toEqual([]);
    expect(early.failures()).toBe(0);
  });

  it("gives way to the fallback from the sentence that failed, for the rest of the conversation", async () => {
    const { asked, sentencesAsked, audio, fallback, speaker, speech, progress, word, failures } =
      speaking();
    await asked[0]!.send();
    audio.advance(50);
    await asked[1]!.refuse();
    expect(failures()).toBe(1);
    // The sentence the downloaded voice has is said to its end first.
    expect(fallback).toEqual([]);
    audio.advance(2 * WORD_MS);
    expect(word()).toBe("three.");
    audio.advance(WORD_MS);
    expect(fallback.map((entry) => entry.text)).toEqual(["Four five."]);

    // What the fallback reports counts from its own text: here it is the whole text's.
    fallback[0]!.report({ sentenceIndex: 0, word: { start: 5, end: 10 }, done: false });
    expect(progress.at(-1)?.sentenceIndex).toBe(1);
    expect(word()).toBe("five.");
    await speech.stop("after-word");
    expect(fallback[0]!.stops).toEqual(["after-word"]);
    fallback[0]!.report({ sentenceIndex: 0, word: null, done: true });
    expect(progress.at(-1)).toEqual({ sentenceIndex: 1, word: null, done: true });

    speaker.speak("Again.", () => {});
    expect(fallback.map((entry) => entry.text)).toEqual(["Four five.", "Again."]);
    expect(sentencesAsked()).toEqual(["One two three.", "Four five."]);
    expect(failures()).toBe(1);
  });

  it("gives the fallback the whole text when the first sentence fails or cannot be played", async () => {
    const refused = speaking();
    await refused.asked[0]!.refuse();
    expect(refused.fallback.map((entry) => entry.text)).toEqual([TEXT]);
    expect(refused.progress).toEqual([]);

    const silent = speaking();
    silent.audio.breakOutput();
    await silent.asked[0]!.send();
    expect(silent.fallback.map((entry) => entry.text)).toEqual([TEXT]);
    expect(silent.failures()).toBe(1);
    expect(silent.audio.played).toEqual([]);
  });
});
