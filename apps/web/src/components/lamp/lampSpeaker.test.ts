import { describe, expect, it, vi } from "vite-plus/test";

import { createLampSpeaker, type LampSpeechEngine } from "./lampSpeaker";
import { INTERRUPT_GRACE_MS, type LampSpeechProgress } from "./lampSpeech.logic";

const TEXT = "One two three. Four five.";

type EngineEvents = Parameters<LampSpeechEngine["speak"]>[1];

/** A voice the test drives: it records what it was asked to say and when it was cut off. */
function fakeEngine() {
  const spoken: { readonly sentence: string; readonly on: EngineEvents }[] = [];
  let cancels = 0;
  const engine: LampSpeechEngine = {
    speak: (sentence, on) => void spoken.push({ sentence, on }),
    cancel: () => void (cancels += 1),
  };
  return { engine, spoken, cancels: () => cancels };
}

async function speaking(text = TEXT) {
  vi.useFakeTimers();
  const voice = fakeEngine();
  const progress: LampSpeechProgress[] = [];
  const speech = createLampSpeaker(voice.engine).speak(text, (next) => void progress.push(next));
  await vi.advanceTimersByTimeAsync(0);
  const word = () => {
    const range = progress.at(-1)?.word;
    return range ? text.slice(range.start, range.end) : null;
  };
  return { ...voice, speech, progress, word };
}

describe("lamp speaker", () => {
  it("speaks sentence by sentence and follows the voice's word boundaries", async () => {
    const { spoken, progress, word } = await speaking();
    try {
      expect(spoken.map((entry) => entry.sentence)).toEqual(["One two three."]);
      spoken[0]!.on.start(1);
      spoken[0]!.on.word(0);
      expect(word()).toBe("One");
      spoken[0]!.on.word(4);
      expect(word()).toBe("two");
      // With boundaries from the voice, the estimate no longer moves the word.
      await vi.advanceTimersByTimeAsync(10_000);
      expect(word()).toBe("two");

      spoken[0]!.on.end();
      expect(spoken.map((entry) => entry.sentence)).toEqual(["One two three.", "Four five."]);
      expect(progress.at(-1)).toEqual({ sentenceIndex: 1, word: null, done: false });
      spoken[1]!.on.word(5);
      expect(word()).toBe("five.");
      spoken[1]!.on.end();
      expect(progress.at(-1)).toEqual({ sentenceIndex: 1, word: null, done: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("estimates each word's start for a voice that reports none", async () => {
    const { spoken, word } = await speaking();
    try {
      spoken[0]!.on.start(1);
      await vi.advanceTimersByTimeAsync(0);
      expect(word()).toBe("One");
      await vi.advanceTimersByTimeAsync(180);
      expect(word()).toBe("two");
      await vi.advanceTimersByTimeAsync(180);
      expect(word()).toBe("three.");
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets the word being spoken finish when the user cuts in", async () => {
    const { spoken, speech, progress, word, cancels } = await speaking();
    try {
      spoken[0]!.on.start(1);
      spoken[0]!.on.word(0);
      const before = cancels();
      let stopped = false;
      void speech.stop("after-word").then(() => (stopped = true));
      await vi.advanceTimersByTimeAsync(100);
      expect(stopped).toBe(false);
      expect(cancels()).toBe(before);

      // The next word starts: the voice stops there, and that word is never reported.
      spoken[0]!.on.word(4);
      await vi.advanceTimersByTimeAsync(0);
      expect(stopped).toBe(true);
      expect(cancels()).toBe(before + 1);
      expect(word()).toBe("One");
      spoken[0]!.on.end();
      expect(spoken).toHaveLength(1);
      expect(progress.some((entry) => entry.done)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops within the grace period when no word starts", async () => {
    const { spoken, speech, word, cancels } = await speaking("Supercalifragilistic word.");
    try {
      spoken[0]!.on.start(1);
      spoken[0]!.on.word(0);
      const before = cancels();
      let stopped = false;
      void speech.stop("after-word").then(() => (stopped = true));
      await vi.advanceTimersByTimeAsync(INTERRUPT_GRACE_MS - 1);
      expect(stopped).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(stopped).toBe(true);
      expect(cancels()).toBe(before + 1);
      expect(word()).toBe("Supercalifragilistic");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not start the next sentence once the user has cut in, and stops at once on request", async () => {
    const cutIn = await speaking();
    try {
      cutIn.spoken[0]!.on.word(8);
      void cutIn.speech.stop("after-word");
      cutIn.spoken[0]!.on.end();
      expect(cutIn.spoken).toHaveLength(1);
      expect(cutIn.word()).toBe("three.");

      const closed = await speaking();
      closed.spoken[0]!.on.word(0);
      const before = closed.cancels();
      await closed.speech.stop("now");
      expect(closed.cancels()).toBe(before + 1);
      closed.spoken[0]!.on.word(4);
      expect(closed.word()).toBe("One");
    } finally {
      vi.useRealTimers();
    }
  });

  it("counts the whole text as said when nothing can speak it", async () => {
    vi.useFakeTimers();
    try {
      const progress: LampSpeechProgress[] = [];
      createLampSpeaker(null).speak(TEXT, (next) => void progress.push(next));
      await vi.advanceTimersByTimeAsync(0);
      expect(progress).toEqual([{ sentenceIndex: 1, word: null, done: true }]);

      const failing = await speaking();
      failing.spoken[0]!.on.error();
      expect(failing.progress.at(-1)?.done).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
