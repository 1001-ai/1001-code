import type { VoiceOutputSpeech } from "@t3tools/contracts";

import {
  INTERRUPT_GRACE_MS,
  splitSentences,
  type LampSpeaker,
  type LampSpeech,
  type LampTextRange,
} from "./lampSpeech.logic";

/** A piece of one sentence's audio. Word offsets count from the start of that sentence. */
export type LampVoiceAudio = Pick<VoiceOutputSpeech, "pcm" | "sampleRate" | "words">;

/** Asks the environment to speak one sentence. Aborting the signal cancels the request. */
export type LampVoiceSource = (
  sentence: string,
  signal: AbortSignal,
) => Promise<ReadonlyArray<LampVoiceAudio>>;

/** Where the audio plays, and the clock it plays against. A test stands in for it. */
export interface LampAudioOutput {
  /** Seconds on the audio clock. */
  now(): number;
  /** Plays 16-bit mono PCM from `at` on the clock and returns how to cut it off. Throws when it cannot play. */
  play(pcm: Uint8Array, sampleRate: number, at: number): () => void;
  /** Runs `run` once the clock reaches `at`, and returns how to call that off. */
  at(at: number, run: () => void): () => void;
}

interface TimedWord {
  readonly range: LampTextRange;
  readonly startsAt: number;
  readonly endsAt: number;
}

/**
 * Speaks with the downloaded voice model: one request a sentence, asked for when the sentence
 * before it starts, played on the audio clock, with the word set from its timing on one timer.
 * When a request or the audio fails, `fallback` speaks from the sentence that failed and
 * everything after it: one speaker serves one conversation.
 */
export function createLampVoiceSpeaker(input: {
  readonly source: LampVoiceSource;
  readonly audio: LampAudioOutput;
  readonly fallback: LampSpeaker;
  /** Called once, when the downloaded voice gives way to the fallback. */
  readonly onFailure: () => void;
}): LampSpeaker {
  const { source, audio, fallback } = input;
  let failed = false;
  return {
    speak(text, onProgress) {
      if (failed) return fallback.speak(text, onProgress);
      const sentences = splitSentences(text);
      const requests = new AbortController();
      const waits = new Set<() => void>();
      const playing: Array<() => void> = [];
      let over = false;
      // When the audio scheduled so far ends, and when the word being spoken does.
      let audioEndsAt = 0;
      let wordEndsAt: number | null = null;
      let stopping: Promise<void> | null = null;
      let stopped: (() => void) | null = null;
      let handedOver: LampSpeech | null = null;

      const when = (at: number, run: () => void) => {
        const cancel = audio.at(at, () => {
          waits.delete(cancel);
          if (!over) run();
        });
        waits.add(cancel);
      };

      const end = (done: boolean) => {
        if (over) return;
        over = true;
        for (const cancel of waits) cancel();
        waits.clear();
        requests.abort();
        if (done) {
          const last = Math.max(0, sentences.length - 1);
          onProgress({ sentenceIndex: last, word: null, done: true });
        } else {
          for (const cut of playing) cut();
        }
        stopped?.();
      };

      const sayWord = (sentenceIndex: number, words: ReadonlyArray<TimedWord>, index: number) => {
        const word = words[index];
        if (!word) return;
        when(word.startsAt, () => {
          // The user cut in while the word before this one was spoken: that word is over now.
          if (stopping) return end(false);
          wordEndsAt = word.endsAt;
          onProgress({ sentenceIndex, word: word.range, done: false });
          sayWord(sentenceIndex, words, index + 1);
        });
      };

      const failedAt = (index: number) => {
        const from = sentences[index]?.start ?? text.length;
        const handOver = () => {
          if (stopping) return end(false);
          handedOver = fallback.speak(text.slice(from), (progress) =>
            onProgress({
              sentenceIndex: progress.sentenceIndex + index,
              word: progress.word && {
                start: progress.word.start + from,
                end: progress.word.end + from,
              },
              done: progress.done,
            }),
          );
        };
        failed = true;
        input.onFailure();
        // What the downloaded voice already has plays out; the fallback starts where it ends.
        if (audioEndsAt <= audio.now()) handOver();
        else when(audioEndsAt, handOver);
      };

      const request = (index: number) => {
        const sentence = sentences[index];
        if (!sentence) return;
        source(text.slice(sentence.start, sentence.end), requests.signal).then(
          (pieces) => {
            // After a cut the stop is already timed, and nothing new starts.
            if (over || stopping) return;
            const startsAt = Math.max(audio.now(), audioEndsAt);
            const words: TimedWord[] = [];
            const scheduled: Array<() => void> = [];
            let at = startsAt;
            try {
              for (const piece of pieces) {
                scheduled.push(audio.play(piece.pcm, piece.sampleRate, at));
                for (const word of piece.words) {
                  words.push({
                    range: { start: sentence.start + word.start, end: sentence.start + word.end },
                    startsAt: at + word.t0Ms / 1000,
                    endsAt: at + word.t1Ms / 1000,
                  });
                }
                at += piece.pcm.byteLength / 2 / piece.sampleRate;
              }
            } catch {
              for (const cut of scheduled) cut();
              return failedAt(index);
            }
            playing.push(...scheduled);
            audioEndsAt = at;
            when(startsAt, () => {
              if (stopping) return end(false);
              onProgress({ sentenceIndex: index, word: null, done: false });
              sayWord(index, words, 0);
              if (index + 1 < sentences.length) request(index + 1);
              else when(audioEndsAt, () => end(true));
            });
          },
          () => {
            if (!over) failedAt(index);
          },
        );
      };

      // Never inside this call: the caller has no speech to stop yet.
      if (sentences.length === 0) queueMicrotask(() => end(true));
      else request(0);

      return {
        stop(mode) {
          if (handedOver) return handedOver.stop(mode);
          if (over) return Promise.resolve();
          if (mode === "now") {
            end(false);
            return Promise.resolve();
          }
          stopping ??= new Promise<void>((resolve) => {
            stopped = resolve;
            const now = audio.now();
            // No word is being spoken, as while the first audio is made: there is nothing to finish.
            if (wordEndsAt === null || wordEndsAt <= now) return end(false);
            when(Math.min(wordEndsAt, now + INTERRUPT_GRACE_MS / 1000), () => end(false));
          });
          return stopping;
        },
      };
    },
  };
}
