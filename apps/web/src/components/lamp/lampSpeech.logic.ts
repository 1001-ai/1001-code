import type { VoiceInputPhase } from "@t3tools/client-runtime/voice-input";

/** A stretch of the text the agent says, as offsets into the whole text. */
export interface LampTextRange {
  readonly start: number;
  readonly end: number;
}

export interface LampSentence extends LampTextRange {
  readonly words: readonly LampTextRange[];
}

/** How far a speech has got. Whatever speaks the text reports it; the captions read only this. */
export interface LampSpeechProgress {
  readonly sentenceIndex: number;
  /** The word being spoken. Null before the first word of a sentence, and when done. */
  readonly word: LampTextRange | null;
  readonly done: boolean;
}

/** A speech in progress. */
export interface LampSpeech {
  /**
   * Ends the speech. `after-word` lets the word being spoken finish: it ends when the next
   * word starts, or after `INTERRUPT_GRACE_MS` if no word starts by then.
   */
  stop(when: "now" | "after-word"): Promise<void>;
}

/** Speaks a text sentence by sentence and reports each word as it starts, then `done` once. */
export interface LampSpeaker {
  speak(text: string, onProgress: (progress: LampSpeechProgress) => void): LampSpeech;
}

export const INTERRUPT_GRACE_MS = 300;

const SENTENCE_END = /[.!?…]+["'”’)\]]*(?=\s)|\n+/g;

export function splitSentences(text: string): readonly LampSentence[] {
  const sentences: LampSentence[] = [];
  const add = (from: number, to: number) => {
    const raw = text.slice(from, to);
    const start = from + (raw.length - raw.trimStart().length);
    const end = start + raw.trim().length;
    if (end === start) return;
    const words = [...text.slice(start, end).matchAll(/\S+/g)].map((match) => ({
      start: start + match.index,
      end: start + match.index + match[0].length,
    }));
    sentences.push({ start, end, words });
  };
  let from = 0;
  for (const match of text.matchAll(SENTENCE_END)) {
    add(from, match[0].startsWith("\n") ? match.index : match.index + match[0].length);
    from = match.index + match[0].length;
  }
  add(from, text.length);
  return sentences;
}

/**
 * The word a voice's boundary event names. `charIndex` counts from the start of the sentence,
 * the text the voice was given. Some voices point at the space before a word: that is the
 * word that follows.
 */
export function wordIndexAtChar(sentence: LampSentence, charIndex: number): number {
  const at = sentence.start + charIndex;
  const index = sentence.words.findIndex((word) => at < word.end);
  return index === -1 ? sentence.words.length - 1 : index;
}

const MS_PER_CHARACTER = 60;
const PAUSE_AFTER_CLAUSE_MS = 180;

/**
 * When each word of a sentence starts, in milliseconds after the sentence does, for a voice
 * that reports no word boundaries: time in proportion to length, and a pause after a clause.
 */
export function estimateWordStartsMs(
  text: string,
  sentence: LampSentence,
  rate = 1,
): readonly number[] {
  let at = 0;
  return sentence.words.map((range) => {
    const start = at;
    const word = text.slice(range.start, range.end);
    const pause = /[,;:—]$/.test(word) ? PAUSE_AFTER_CLAUSE_MS : 0;
    at += (Math.max(word.length, 2) * MS_PER_CHARACTER + pause) / rate;
    return start;
  });
}

/** The word being spoken at a time into the sentence, or -1 before the first. */
export function wordIndexAtElapsed(startsMs: readonly number[], elapsedMs: number): number {
  return startsMs.findLastIndex((start) => start <= elapsedMs);
}

/** How much of the text has been spoken once the word in progress is over. */
function spokenOffset(
  text: string,
  sentences: readonly LampSentence[],
  progress: LampSpeechProgress,
): number {
  if (progress.done) return text.length;
  if (progress.word) return progress.word.end;
  return sentences[progress.sentenceIndex]?.start ?? 0;
}

/** What the agent is saying or said last, and how far it got. */
export interface LampSaid {
  readonly text: string;
  readonly sentences: readonly LampSentence[];
  readonly progress: LampSpeechProgress;
  /** Set when the speech ended early: how much of the text was spoken. */
  readonly stoppedAt: number | null;
}

/** Where the user cut the agent off, for the agent that answers next. */
export interface LampInterruption {
  readonly spoken: string;
  readonly unspoken: string;
  /** What the user said then. Null until it is transcribed. */
  readonly transcript: string | null;
}

export interface LampVoiceSession {
  readonly said: LampSaid | null;
  readonly speaking: boolean;
  readonly interruption: LampInterruption | null;
  /** What the user said last. */
  readonly heard: string | null;
}

export const LAMP_VOICE_SILENT: LampVoiceSession = {
  said: null,
  speaking: false,
  interruption: null,
  heard: null,
};

/** A text is about to be spoken. It starts a new exchange. */
export function lampSpeechQueued(text: string): LampVoiceSession {
  return {
    ...LAMP_VOICE_SILENT,
    said: {
      text,
      sentences: splitSentences(text),
      progress: { sentenceIndex: 0, word: null, done: false },
      stoppedAt: null,
    },
  };
}

export function lampSpeechBegan(session: LampVoiceSession): LampVoiceSession {
  return session.said ? { ...session, speaking: true } : session;
}

export function lampSpeechProgressed(
  session: LampVoiceSession,
  progress: LampSpeechProgress,
): LampVoiceSession {
  if (!session.said || session.said.stoppedAt !== null) return session;
  return { ...session, said: { ...session.said, progress }, speaking: !progress.done };
}

/** The voice went quiet without the user cutting in, as when the layer closes. */
export function lampSpeechSilenced(session: LampVoiceSession): LampVoiceSession {
  return session.speaking ? { ...session, speaking: false } : session;
}

/** The user cut in. If the agent had not finished, where it stopped is kept. */
export function lampSpeechInterrupted(session: LampVoiceSession): LampVoiceSession {
  const said = session.said;
  if (!said || said.progress.done || said.stoppedAt !== null) {
    return lampSpeechSilenced(session);
  }
  const stoppedAt = spokenOffset(said.text, said.sentences, said.progress);
  return {
    ...session,
    speaking: false,
    said: { ...said, stoppedAt },
    interruption: {
      spoken: said.text.slice(0, stoppedAt).trimEnd(),
      unspoken: said.text.slice(stoppedAt).trimStart(),
      transcript: null,
    },
  };
}

/** The user starts to talk: what they said before gives way to what they say now. */
export function lampListeningBegan(session: LampVoiceSession): LampVoiceSession {
  return session.heard === null ? session : { ...session, heard: null };
}

/** The user's words are transcribed. They complete an interruption that waits for them. */
export function lampUserHeard(session: LampVoiceSession, transcript: string): LampVoiceSession {
  const interruption = session.interruption;
  return {
    ...session,
    heard: transcript,
    interruption:
      interruption && interruption.transcript === null
        ? { ...interruption, transcript }
        : interruption,
  };
}

/**
 * The user starts to talk. Capture starts at the press, so their first words are kept and a hold
 * is timed from it, while the agent finishes the word it is on. `open` is false once the layer
 * closes: every wait asks it again, so nothing starts then and a capture that did is cancelled.
 */
export async function lampTalk(input: {
  readonly open: () => boolean;
  /** What the agent is saying, if it is speaking. */
  readonly speech: LampSpeech | null;
  readonly microphone: { start(): Promise<void>; cancel(): void };
  readonly onInterrupted: () => void;
}): Promise<void> {
  if (!input.open()) return;
  // The microphone may catch the end of that word: nothing here can tell whether it does.
  const quiet = input.speech?.stop("after-word").then(() => {
    if (input.open()) input.onInterrupted();
  });
  await input.microphone.start();
  if (!input.open()) input.microphone.cancel();
  await quiet;
}

/** The agent's text in the three parts the captions colour: spoken, being spoken, to come. */
export function captionParts(said: LampSaid): {
  readonly spoken: string;
  readonly current: string;
  readonly upcoming: string;
} {
  const { text, progress } = said;
  const word = said.stoppedAt === null ? progress.word : null;
  const spokenEnd =
    said.stoppedAt ?? (word ? word.start : spokenOffset(text, said.sentences, progress));
  const currentEnd = word ? word.end : spokenEnd;
  return {
    spoken: text.slice(0, spokenEnd),
    current: text.slice(spokenEnd, currentEnd),
    upcoming: text.slice(currentEnd),
  };
}

const STOPPED_AFTER_WORDS = 4;

/** The one line that shows where the agent stopped. */
export function stoppedAfterLine(interruption: LampInterruption): string {
  const words = interruption.spoken.split(/\s+/).filter(Boolean);
  if (words.length === 0) return "Stopped before the first word.";
  const tail = words.slice(-STOPPED_AFTER_WORDS).join(" ");
  return `Stopped after "${words.length > STOPPED_AFTER_WORDS ? "…" : ""}${tail}"`;
}

export type LampStatus = "idle" | "speaking" | "listening" | "thinking";

export const LAMP_STATUS_LABEL: Record<LampStatus, string> = {
  idle: "Idle",
  speaking: "Speaking",
  listening: "Listening",
  thinking: "Thinking",
};

/**
 * Listening lasts until the user's words are transcribed, and wins over the rest: the user has
 * the floor. Thinking is the agent at work on an answer it is not saying yet.
 */
export function lampStatus(input: {
  readonly speaking: boolean;
  readonly voicePhase: VoiceInputPhase;
  readonly thinking: boolean;
}): LampStatus {
  if (input.voicePhase !== "idle" && input.voicePhase !== "error") return "listening";
  if (input.speaking) return "speaking";
  return input.thinking ? "thinking" : "idle";
}

export type LampVoiceReadiness = "ready" | "not-set-up" | "missing-model" | "unavailable";

/** Whether dictation can start, and if not, which one line says why. */
export function lampVoiceReadiness(input: {
  readonly available: boolean;
  readonly destinationChosen: boolean;
  readonly missingModel: boolean;
}): LampVoiceReadiness {
  if (!input.available) return "unavailable";
  if (!input.destinationChosen) return "not-set-up";
  return input.missingModel ? "missing-model" : "ready";
}
