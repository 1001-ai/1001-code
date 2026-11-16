import type { VoiceOutputWord } from "@t3tools/contracts";

export type VoiceOutputSentence = {
  readonly text: string;
  /** UTF-16 index of the sentence's first character in the whole text. */
  readonly start: number;
};

const SENTENCE_MARKS = new Set([".", "!", "?", "。", "！", "？", "…"]);
const CLOSING_MARKS = new Set(['"', "'", "”", "’", ")", "]"]);

// One pass, not a regular expression: one backtracks on a long run of marks with no space after.
function* sentenceEnds(text: string): Generator<number> {
  let at = 0;
  while (at < text.length) {
    const character = text[at]!;
    if (character === "\n") {
      while (text[at] === "\n") at += 1;
      yield at;
    } else if (SENTENCE_MARKS.has(character)) {
      while (at < text.length && SENTENCE_MARKS.has(text[at]!)) at += 1;
      while (at < text.length && CLOSING_MARKS.has(text[at]!)) at += 1;
      if (at === text.length || /\s/.test(text[at]!)) yield at;
    } else {
      at += 1;
    }
  }
}

/**
 * Cuts a text into the sentences the server speaks one at a time, so playback starts after the
 * first. A sentence longer than `limit` is cut at a space; nothing but blank space is dropped.
 */
export function splitVoiceOutputSentences(text: string, limit: number): VoiceOutputSentence[] {
  const sentences: VoiceOutputSentence[] = [];
  const push = (from: number, to: number) => {
    const piece = text.slice(from, to);
    const lead = piece.length - piece.trimStart().length;
    const trimmed = piece.trim();
    if (trimmed.length === 0) return;
    let start = from + lead;
    let rest = trimmed;
    while (rest.length > limit) {
      const space = rest.lastIndexOf(" ", limit);
      let at = space > 0 ? space : limit;
      // Never cut between the two halves of a surrogate pair.
      if (/[\uD800-\uDBFF]/.test(rest[at - 1] ?? "")) at -= 1;
      const head = rest.slice(0, at).trimEnd();
      if (head.length > 0) sentences.push({ text: head, start });
      const tail = rest.slice(at);
      start += at + (tail.length - tail.trimStart().length);
      rest = tail.trimStart();
    }
    if (rest.length > 0) sentences.push({ text: rest, start });
  };
  let from = 0;
  for (const to of sentenceEnds(text)) {
    push(from, to);
    from = to;
  }
  push(from, text.length);
  return sentences;
}

/** The word being spoken at `timeMs` into the audio; before the first or after the last, none. */
export function voiceOutputWordAt(
  words: ReadonlyArray<VoiceOutputWord>,
  timeMs: number,
): VoiceOutputWord | undefined {
  let low = 0;
  let high = words.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const word = words[middle]!;
    if (timeMs < word.t0Ms) high = middle - 1;
    else if (timeMs >= word.t1Ms) low = middle + 1;
    else return word;
  }
  return undefined;
}
