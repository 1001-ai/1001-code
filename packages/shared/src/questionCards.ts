// The question cards an agent writes into its replies (see the ask-the-user skill). The web
// client renders them; the server reads them to tell clients a thread is waiting on the user.

/** Joins the options a pick-any answer selects. */
export const QUESTION_MULTI_SEPARATOR = ", ";

/** The answer a card's Skip gives; agents stop the work that depends on that question. */
export const QUESTION_SKIPPED_ANSWER = "skipped";

/**
 * The answer a card's Dismiss gives: the card closes without the agent being told. The client
 * records a message of only `<id>: dismissed` lines without starting a turn.
 */
export const QUESTION_DISMISSED_ANSWER = "dismissed";

const DISMISSAL_LINE = /^Q[1-9][0-9]*: dismissed$/;

/**
 * Whether `text` is only `Qn: dismissed` lines, one per line, with nothing else. The server's SQL
 * form (`questionDismissalMessageSql`) must accept exactly the same texts.
 */
export function isQuestionDismissalText(text: string): boolean {
  return text.length > 0 && text.split("\n").every((line) => DISMISSAL_LINE.test(line));
}

/**
 * A dismissal recorded without a run: it closes cards but is not the user writing to the agent,
 * so it moves no "latest user message" time.
 */
export function isQuestionDismissalMessage(message: {
  readonly role: string;
  readonly runId: string | null;
  readonly text: string;
  readonly attachments?: ReadonlyArray<unknown> | undefined;
}): boolean {
  return (
    message.role === "user" &&
    message.runId === null &&
    (message.attachments?.length ?? 0) === 0 &&
    isQuestionDismissalText(message.text)
  );
}

/** The ids a dismissal text closes, in order; empty when the text is not one. */
export function questionDismissalIds(text: string): ReadonlyArray<string> {
  return isQuestionDismissalText(text)
    ? text.split("\n").map((line) => line.slice(0, line.indexOf(":")))
    : [];
}

/** The text of a message that dismisses `ids`. */
export function questionDismissalText(ids: ReadonlyArray<string>): string {
  return ids.map((id) => `${id}: ${QUESTION_DISMISSED_ANSWER}`).join("\n");
}

/**
 * What an agent writes after a card's id, as a whole `Q2: no longer needed` line, to withdraw one
 * of its latest unanswered cards that a newer user message made pointless.
 */
export const QUESTION_WITHDRAWN_ANSWER = "no longer needed";

export interface QuestionBlock {
  readonly id: string;
  readonly prompt: string;
  readonly kind: "choice" | "multi" | "boolean" | "text";
  /** Set for `choice` and `multi` only. */
  readonly options?: ReadonlyArray<string>;
  readonly recommended?: string;
}

// Line breaks would let one answer forge another `<id>:` line; invisible and bidi
// characters would make the draft say something other than what the card shows.
const VISIBLE_SINGLE_LINE = /^[^\p{Cc}\p{Cf}\u2028\u2029]*$/u;

function isVisibleText(value: string, max: number): boolean {
  return (
    value.length > 0 &&
    value.length <= max &&
    value.trim() === value &&
    VISIBLE_SINGLE_LINE.test(value)
  );
}

// Up to 3 spaces before `>`, as CommonMark allows; deeper or lazy lines belong to something else.
const QUOTE_LINE = /^ {0,3}> ?(.*)$/;
const QUOTE_HEADER = /^\*\*(Q[1-9][0-9]{0,5}) · (.+)\*\*( \(pick any\))?$/;
const PICK_ANY_SUFFIX = " (pick any)";
const QUOTE_OPTION = /^- (.*)$/;
// Text that CommonMark would read as a nested block (list, quote, heading, task box, code fence,
// thematic break) is not a plain option; `-1`, `+5%`, `*args` and `#hash` stay plain text.
const NESTED_BLOCK_START =
  /^(?:[-*+](?:[ \t]|$)|>|#{1,6}(?:[ \t]|$)|\d{1,9}[.)](?:[ \t]|$)|\[[ xX]\](?:[ \t]|$)|`{3}|~{3}|(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$)/;
// Either emphasis marker, since markdown formatters rewrite `*x*` as `_x_`.
const RECOMMENDED_SUFFIX = / (?:\*\(recommended\)\*|_\(recommended\)_)$/;
const REPLY_HINT = /^(?:_Reply with .+_|\*Reply with .+\*)$/;

/**
 * A blockquote's markdown source as a question, or null when it is an ordinary quote:
 * a bold `**Q<n> · prompt**` line, which may end ` (pick any)` inside or after the bold, then
 * 2 to 8 `- option` items (one may end ` _(recommended)_`) or one `_Reply with …_` line for text.
 */
export function parseQuestionQuote(source: string): QuestionBlock | null {
  if (source.length > 4_000) return null;
  const lines: string[] = [];
  for (const raw of source.split(/\r\n|\r|\n/)) {
    const line = QUOTE_LINE.exec(raw)?.[1]?.trimEnd();
    if (line === undefined) return null;
    if (line.length > 0) lines.push(line);
  }
  const [header = "", ...body] = lines;
  const heading = QUOTE_HEADER.exec(header);
  if (!heading) return null;
  const [, id = "", boldText = "", pickAnyAfterBold] = heading;
  const pickAnyInBold = boldText.endsWith(PICK_ANY_SUFFIX);
  const prompt = pickAnyInBold ? boldText.slice(0, -PICK_ANY_SUFFIX.length) : boldText;
  const pickAny = pickAnyInBold || pickAnyAfterBold !== undefined;
  if (prompt.includes("**") || !isVisibleText(prompt, 500)) return null;

  const [hint] = body;
  if (body.length === 1 && hint !== undefined && REPLY_HINT.test(hint)) {
    if (pickAny || !isVisibleText(hint, 500)) return null;
    return { id, prompt, kind: "text" };
  }

  const options: string[] = [];
  let recommended: string | undefined;
  for (const line of body) {
    let option = QUOTE_OPTION.exec(line)?.[1];
    if (option === undefined || NESTED_BLOCK_START.test(option)) return null;
    const marker = RECOMMENDED_SUFFIX.exec(option);
    if (marker) {
      if (recommended !== undefined) return null;
      option = option.slice(0, marker.index);
      recommended = option;
    }
    if (!isVisibleText(option, 120) || options.includes(option)) return null;
    options.push(option);
  }
  if (options.length < 2 || options.length > 8) return null;
  const recommendation = recommended === undefined ? {} : { recommended };
  if (pickAny) {
    // A multi answer joins options with the separator, so an option containing it can't round-trip.
    if (options.some((option) => option.includes(QUESTION_MULTI_SEPARATOR))) return null;
    return { id, prompt, kind: "multi", options, ...recommendation };
  }
  if (options.length === 2 && options[0] === "Yes" && options[1] === "No") {
    return { id, prompt, kind: "boolean", ...recommendation };
  }
  return { id, prompt, kind: "choice", options, ...recommendation };
}

const CARD_HEADER_HINT = /^ {0,3}> ?\*\*Q[1-9]/m;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

export interface QuestionQuoteMatch {
  readonly source: string;
  readonly card: QuestionBlock;
  readonly start: number;
  readonly end: number;
}

/**
 * The question cards in an assistant message's markdown with each quote's source and UTF-16
 * offsets: each run of quote lines that `parseQuestionQuote` accepts. Quotes in code fences, and
 * quotes a lazy line continues, are not cards.
 */
export function questionQuoteSourcesInMarkdown(text: string): ReadonlyArray<QuestionQuoteMatch> {
  if (!CARD_HEADER_HINT.test(text)) return [];
  const matches: QuestionQuoteMatch[] = [];
  let quote: string[] = [];
  let quoteStart = 0;
  let quoteEnd = 0;
  let continued = false;
  let fence: string | null = null;
  const flush = () => {
    if (quote.length > 0 && !continued) {
      const source = quote.join("\n");
      const card = parseQuestionQuote(source);
      if (card) matches.push({ source, card, start: quoteStart, end: quoteEnd });
    }
    quote = [];
    continued = false;
  };
  let lineStart = 0;
  while (lineStart < text.length) {
    let lineEnd = lineStart;
    while (lineEnd < text.length && text[lineEnd] !== "\n" && text[lineEnd] !== "\r") lineEnd++;
    const line = text.slice(lineStart, lineEnd);
    const nextLineStart =
      text[lineEnd] === "\r" && text[lineEnd + 1] === "\n"
        ? lineEnd + 2
        : lineEnd < text.length
          ? lineEnd + 1
          : lineEnd;
    const marker = FENCE.exec(line)?.[1];
    if (fence !== null) {
      if (marker?.startsWith(fence) && line.trim() === marker) {
        fence = null;
      }
      lineStart = nextLineStart;
      continue;
    }
    if (marker !== undefined) {
      flush();
      fence = marker;
    } else if (QUOTE_LINE.test(line)) {
      if (quote.length === 0) quoteStart = lineStart;
      quoteEnd = lineEnd;
      quote.push(line);
    } else if (line.trim().length === 0) {
      flush();
    } else if (quote.length > 0) {
      continued = true;
    }
    lineStart = nextLineStart;
  }
  flush();
  return matches;
}

/**
 * The question cards in an assistant message's markdown: each run of quote lines that
 * `parseQuestionQuote` accepts. Quotes in code fences, and quotes a lazy line continues, are not cards.
 */
export function questionCardsInMarkdown(text: string): ReadonlyArray<QuestionBlock> {
  return questionQuoteSourcesInMarkdown(text).map((match) => match.card);
}

// Up to three spaces of indent: four or a tab make an indented code block.
const WITHDRAW_LINE = /^ {0,3}(Q[1-9][0-9]{0,5})[ \t]*:(.*)$/;

/**
 * The card ids an assistant message withdraws: each whole `Qn: no longer needed` line outside code.
 * They apply to the newest earlier message that asks cards; an answer the user gives still wins.
 */
export function questionWithdrawalsInMarkdown(text: string): ReadonlyArray<string> {
  if (!text.includes(QUESTION_WITHDRAWN_ANSWER)) return [];
  const ids: string[] = [];
  let fence: string | null = null;
  for (const line of text.split(/\r\n|\r|\n/)) {
    const marker = FENCE.exec(line)?.[1];
    if (fence !== null) {
      if (marker?.startsWith(fence) && line.trim() === marker) fence = null;
      continue;
    }
    if (marker !== undefined) {
      fence = marker;
      continue;
    }
    const match = WITHDRAW_LINE.exec(line);
    const id = match?.[1];
    if (id !== undefined && match?.[2]?.trim() === QUESTION_WITHDRAWN_ANSWER && !ids.includes(id)) {
      ids.push(id);
    }
  }
  return ids;
}

// The value is trimmed in code: a lazy capture before trailing blanks backtracks polynomially.
const ANSWER_LINE = /^[ \t]*([A-Za-z][A-Za-z0-9_-]*)[ \t]*:(.*)$/;

/** The answer one line gives `id` (empty for a bare `<id>:`), or null when it is not that id's line. */
export function answerOnLine(line: string, id: string): string | null {
  const match = ANSWER_LINE.exec(line);
  return match?.[1] === id ? (match[2] ?? "").trim() : null;
}

/** The answer a `<id>: answer` line in `text` gives, or null when no line answers it. */
export function readAnswerLine(text: string, id: string): string | null {
  for (const line of text.split("\n")) {
    const answer = answerOnLine(line, id);
    if (answer !== null && answer.length > 0) return answer;
  }
  return null;
}

export interface QuestionThreadMessage {
  readonly role: string;
  readonly text: string;
  readonly streaming?: boolean | undefined;
}

export interface OpenQuestion<M> {
  readonly question: QuestionBlock;
  /** The assistant message that asked it. */
  readonly message: M;
}

/**
 * The cards still open in a thread's messages, given oldest first, in the order they were asked.
 * Each id's newest card counts. A card stays open until a later user message carries its own
 * `<id>: answer` line (a skip or a dismissal is one), or the agent withdraws it while its message still holds
 * the latest cards. Streaming messages ask nothing yet.
 */
export function openQuestionCards<M extends QuestionThreadMessage>(
  messages: Iterable<M>,
  cardsOf: (message: M) => ReadonlyArray<QuestionBlock> = (message) =>
    questionCardsInMarkdown(message.text),
): ReadonlyArray<OpenQuestion<M>> {
  const open = new Map<string, OpenQuestion<M>>();
  // A withdrawal applies to the newest earlier message that asks cards.
  let latestAsking: M | null = null;
  for (const message of messages) {
    if (message.role === "user") {
      for (const id of open.keys()) {
        if (readAnswerLine(message.text, id) !== null) open.delete(id);
      }
      continue;
    }
    if (message.role !== "assistant" || message.streaming === true) continue;
    for (const id of questionWithdrawalsInMarkdown(message.text)) {
      if (open.get(id)?.message === latestAsking) open.delete(id);
    }
    const cards = cardsOf(message);
    if (cards.length === 0) continue;
    latestAsking = message;
    for (const question of cards) {
      // A re-asked id moves to where it was asked last.
      open.delete(question.id);
      open.set(question.id, { question, message });
    }
  }
  return [...open.values()];
}
