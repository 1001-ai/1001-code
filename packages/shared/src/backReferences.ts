// The `(↑ "words")` markers an agent writes to point back at something said earlier in the chat.
// T3 Code's instructions teach the format (provider-core's backReferenceInstructions.ts); the web
// client links each one to the earlier message holding those words, and the evals grade markers
// with the same matching.

export interface BackReference {
  /** The marker as written, parentheses included. */
  readonly text: string;
  /** The words quoted from the earlier message. */
  readonly excerpt: string;
  readonly start: number;
  readonly end: number;
}

// Straight or curly quotes; the excerpt holds no quote, parenthesis or line break, so an
// unfinished marker never matches and the scan stays linear.
const BACK_REFERENCE = /\(↑ ?["“]([^"“”()\n]{1,200})["”]\)/g;

/** The complete back-reference markers in `text`, in order. */
export function findBackReferences(text: string): ReadonlyArray<BackReference> {
  if (!text.includes("↑")) return [];
  const references: BackReference[] = [];
  for (const match of text.matchAll(BACK_REFERENCE)) {
    const excerpt = match[1]!.trim();
    if (excerpt === "") continue;
    references.push({
      text: match[0],
      excerpt,
      start: match.index,
      end: match.index + match[0].length,
    });
  }
  return references;
}

// Matching works on words: runs of letters, digits and marks, joined by inner underscores, with
// each Han or kana character a word of its own. Punctuation, quote style, dashes, ellipses,
// markdown marks, case and spacing never count.
const WORD =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]|[\p{L}\p{N}\p{M}]+(?:_+[\p{L}\p{N}\p{M}]+)*/gu;

export interface QuoteWord {
  /** The word folded for comparison. */
  readonly value: string;
  /** Where the word sits in the text it came from. */
  readonly start: number;
  readonly end: number;
}

export type QuoteWords = ReadonlyArray<QuoteWord>;

export function quoteWords(text: string): QuoteWords {
  const words: QuoteWord[] = [];
  for (const match of text.matchAll(WORD)) {
    words.push({
      value: match[0].normalize("NFKC").toLowerCase(),
      start: match.index,
      end: match.index + match[0].length,
    });
  }
  return words;
}

/**
 * Where a quote sits in a text, as offsets into that text. `exact`: its words in a row. `close`:
 * most of its words in the same order within a short passage, for a quote the agent misremembered.
 */
export interface QuoteMatch {
  readonly kind: "exact" | "close";
  readonly start: number;
  readonly end: number;
}

/** A close match holds at least this share of the quote's words, in order, and at least 3. */
const CLOSE_SHARE = 0.75;
const CLOSE_MIN_WORDS = 3;

function exactMatch(haystack: QuoteWords, needle: QuoteWords): QuoteMatch | null {
  const last = haystack.length - needle.length;
  outer: for (let at = 0; at <= last; at += 1) {
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (haystack[at + offset]!.value !== needle[offset]!.value) continue outer;
    }
    return {
      kind: "exact",
      start: haystack[at]!.start,
      end: haystack[at + needle.length - 1]!.end,
    };
  }
  return null;
}

function closeMatch(haystack: QuoteWords, needle: QuoteWords): QuoteMatch | null {
  const size = needle.length;
  const needed = Math.max(CLOSE_MIN_WORDS, Math.ceil(size * CLOSE_SHARE));
  if (size < needed) return null;
  const inQuote = new Set(needle.map((word) => word.value));
  let present = 0;
  for (const word of haystack) if (inQuote.has(word.value)) present += 1;
  if (present < needed) return null;
  // The passage may hold a few words the quote left out, not much more.
  const longest = size + Math.ceil(size / 2);
  let best: { score: number; start: number; end: number } | null = null;
  const previous = new Array<number>(size + 1);
  const current = new Array<number>(size + 1);
  for (let start = 0; start < haystack.length; start += 1) {
    if (!inQuote.has(haystack[start]!.value)) continue;
    previous.fill(0);
    let score = 0;
    let end = start;
    const stop = Math.min(haystack.length, start + longest);
    // Longest common subsequence of the quote and the passage growing from `start`.
    for (let at = start; at < stop; at += 1) {
      const value = haystack[at]!.value;
      current[0] = 0;
      for (let index = 1; index <= size; index += 1) {
        current[index] =
          needle[index - 1]!.value === value
            ? previous[index - 1]! + 1
            : Math.max(previous[index]!, current[index - 1]!);
      }
      for (let index = 0; index <= size; index += 1) previous[index] = current[index]!;
      if (previous[size]! > score) {
        score = previous[size]!;
        end = at;
      }
    }
    if (score >= needed && (best === null || score > best.score)) {
      best = { score, start, end };
      if (score === size) break;
    }
  }
  if (best === null) return null;
  // A passage may open on a quote word its best alignment skips; start at the first one it uses.
  while (
    best.start < best.end &&
    commonWords(needle, haystack, best.start + 1, best.end) === best.score
  ) {
    best.start += 1;
  }
  return { kind: "close", start: haystack[best.start]!.start, end: haystack[best.end]!.end };
}

/** Length of the longest common subsequence of `needle` and `haystack[from..to]`. */
function commonWords(needle: QuoteWords, haystack: QuoteWords, from: number, to: number): number {
  let previous = new Array<number>(needle.length + 1).fill(0);
  for (let at = from; at <= to; at += 1) {
    const current = [0];
    for (let index = 1; index <= needle.length; index += 1) {
      current[index] =
        needle[index - 1]!.value === haystack[at]!.value
          ? previous[index - 1]! + 1
          : Math.max(previous[index]!, current[index - 1]!);
    }
    previous = current;
  }
  return previous[needle.length]!;
}

/**
 * Where `quote` sits in `text`: the first exact occurrence, else the closest passage. Null when
 * the text holds neither. `kinds: "exact"` skips the close search.
 */
export function matchQuote(
  text: string | QuoteWords,
  quote: string | QuoteWords,
  kinds: "exact" | "exact-or-close" = "exact-or-close",
): QuoteMatch | null {
  const needle = typeof quote === "string" ? quoteWords(quote) : quote;
  if (needle.length === 0) return null;
  const haystack = typeof text === "string" ? quoteWords(text) : text;
  return exactMatch(haystack, needle) ?? (kinds === "exact" ? null : closeMatch(haystack, needle));
}

/**
 * The message a quote points at among `messages`, oldest first: the newest that holds it exactly,
 * else the newest that holds a close match. An exact match in any message wins over a close one.
 */
export function findQuotedMessage<T>(
  messages: ReadonlyArray<T>,
  wordsOf: (message: T) => QuoteWords,
  quote: string,
): { readonly message: T; readonly match: QuoteMatch } | null {
  const needle = quoteWords(quote);
  if (needle.length === 0) return null;
  for (const kinds of ["exact", "exact-or-close"] as const) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index]!;
      const match = matchQuote(wordsOf(message), needle, kinds);
      if (match !== null) return { message, match };
    }
  }
  return null;
}

const FENCE_LINE = /^ {0,3}(?:`{3,}|~{3,})[^\n]*$/gm;
const LINK_DEFINITION = /^ {0,3}\[[^\]\n]+\]:[^\n]*$/gm;
const INLINE_LINK = /!?\[([^\]\n]*)\]\((?:[^()\s]|\([^()\s]*\))*(?:\s+(?:"[^"\n]*"|'[^'\n]*'))?\)/g;
const REFERENCE_LINK = /!?\[([^\]\n]+)\]\[[^\]\n]*\]/g;
const AUTOLINK = /<((?:https?|mailto):[^>\s]+)>/g;
const HTML_TAG = /<\/?[A-Za-z][^>\n]*>/g;
const LIST_MARKER = /^[ \t]*(?:>[ \t]*)*(?:[-*+]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/gm;

/**
 * The words of a markdown message as chat shows them: link targets, list numbers, task boxes,
 * fence info and tags dropped. Punctuation stays, since matching ignores it anyway.
 */
export function markdownDisplayText(markdown: string): string {
  return markdown
    .replace(FENCE_LINE, "")
    .replace(LINK_DEFINITION, "")
    .replace(INLINE_LINK, "$1")
    .replace(REFERENCE_LINK, "$1")
    .replace(AUTOLINK, "$1")
    .replace(HTML_TAG, " ")
    .replace(LIST_MARKER, "");
}
