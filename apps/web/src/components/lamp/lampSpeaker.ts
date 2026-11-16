import {
  INTERRUPT_GRACE_MS,
  estimateWordStartsMs,
  splitSentences,
  wordIndexAtChar,
  type LampSentence,
  type LampSpeaker,
  type LampSpeech,
} from "./lampSpeech.logic";

/** What the speaker needs from a voice: say one sentence, and stop. A test stands in for it. */
export interface LampSpeechEngine {
  speak(
    sentence: string,
    on: {
      /** The sentence is audible, at this speaking rate (1 is normal). */
      readonly start: (rate: number) => void;
      /** A word starts at this offset into the sentence. Not every voice reports it. */
      readonly word: (charIndex: number) => void;
      readonly end: () => void;
      readonly error: () => void;
    },
  ): void;
  cancel(): void;
}

function browserSpeechEngine(): LampSpeechEngine | null {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return null;
  const synthesis = window.speechSynthesis;
  // Chrome drops the events of an utterance nothing else refers to.
  let current: SpeechSynthesisUtterance | null = null;
  return {
    speak(sentence, on) {
      const utterance = new SpeechSynthesisUtterance(sentence);
      current = utterance;
      utterance.onstart = () => on.start(utterance.rate);
      utterance.onboundary = (event) => {
        if (event.name === "word") on.word(event.charIndex);
      };
      const release = () => {
        if (current === utterance) current = null;
      };
      utterance.onend = () => {
        release();
        on.end();
      };
      utterance.onerror = () => {
        release();
        on.error();
      };
      synthesis.speak(utterance);
    },
    cancel() {
      current = null;
      if (synthesis.speaking || synthesis.pending) synthesis.cancel();
    },
  };
}

/**
 * Speaks with the browser's own voices. A stand-in: a voice model that sends audio with word
 * timings replaces it behind the same `LampSpeaker`. A voice that reports word boundaries sets
 * the word; for one that does not, each word's start is estimated from the text.
 */
export function createLampSpeaker(engine = browserSpeechEngine()): LampSpeaker {
  return {
    speak(text, onProgress) {
      const sentences = splitSentences(text);
      let sentenceIndex = -1;
      let wordIndex = -1;
      let over = false;
      let voiceReportsWords = false;
      let estimate: ReturnType<typeof setTimeout> | undefined;
      let grace: ReturnType<typeof setTimeout> | undefined;
      let stopped: (() => void) | null = null;
      let stopping: Promise<void> | null = null;

      const end = (done: boolean) => {
        if (over) return;
        over = true;
        clearTimeout(estimate);
        clearTimeout(grace);
        engine?.cancel();
        if (done) {
          const last = Math.max(0, sentences.length - 1);
          onProgress({ sentenceIndex: last, word: null, done: true });
        }
        stopped?.();
      };

      const wordStarted = (sentence: LampSentence, index: number) => {
        if (over || index <= wordIndex) return;
        // The user cut in while the word before this one was spoken: that word is over now.
        if (stopping) return end(false);
        wordIndex = index;
        onProgress({ sentenceIndex, word: sentence.words[index] ?? null, done: false });
      };

      const estimateWords = (sentence: LampSentence, rate: number) => {
        const starts = estimateWordStartsMs(text, sentence, rate);
        const begun = performance.now();
        const next = (index: number) => {
          if (over || voiceReportsWords || index >= starts.length) return;
          const wait = (starts[index] ?? 0) - (performance.now() - begun);
          estimate = setTimeout(
            () => {
              wordStarted(sentence, index);
              next(index + 1);
            },
            Math.max(0, wait),
          );
        };
        next(0);
      };

      const speakNext = () => {
        if (over) return;
        clearTimeout(estimate);
        sentenceIndex += 1;
        wordIndex = -1;
        const sentence = sentences[sentenceIndex];
        if (!engine || !sentence) return end(true);
        if (stopping) return end(false);
        const index = sentenceIndex;
        const current = () => !over && sentenceIndex === index;
        onProgress({ sentenceIndex, word: null, done: false });
        engine.speak(text.slice(sentence.start, sentence.end), {
          start: (rate) => {
            if (current() && !voiceReportsWords) estimateWords(sentence, rate);
          },
          word: (charIndex) => {
            if (!current()) return;
            voiceReportsWords = true;
            clearTimeout(estimate);
            wordStarted(sentence, wordIndexAtChar(sentence, charIndex));
          },
          end: () => {
            if (current()) speakNext();
          },
          // A voice that cannot speak leaves the text as the captions: all of it counts as said.
          error: () => {
            if (current()) end(true);
          },
        });
      };

      // A speech left queued or paused would hold this one back.
      engine?.cancel();
      queueMicrotask(speakNext);

      const speech: LampSpeech = {
        stop(when) {
          if (over) return Promise.resolve();
          if (when === "now") {
            end(false);
            return Promise.resolve();
          }
          stopping ??= new Promise<void>((resolve) => {
            stopped = resolve;
            grace = setTimeout(() => end(false), INTERRUPT_GRACE_MS);
          });
          return stopping;
        },
      };
      return speech;
    },
  };
}

/** The voice the layer speaks with. Replace this one line to change how the agent sounds. */
export const lampSpeaker: LampSpeaker = createLampSpeaker();
