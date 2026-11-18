// The question cards an agent writes into its replies (see the ask-the-user skill). The web
// client renders them; the server reads them to tell clients a thread is waiting on the user.

/** Joins the options a pick-any answer selects. */
export const QUESTION_MULTI_SEPARATOR = ", ";

/** The answer a card's Skip gives; agents stop the work that depends on that question. */
export const QUESTION_SKIPPED_ANSWER = "skipped";

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

/**
 * The question cards in an assistant message's markdown: each run of quote lines that
 * `parseQuestionQuote` accepts. Quotes in code fences, and quotes a lazy line continues, are not cards.
 */
export function questionCardsInMarkdown(text: string): ReadonlyArray<QuestionBlock> {
  if (!CARD_HEADER_HINT.test(text)) return [];
  const cards: QuestionBlock[] = [];
  let quote: string[] = [];
  let continued = false;
  let fence: string | null = null;
  const flush = () => {
    const card = quote.length > 0 && !continued ? parseQuestionQuote(quote.join("\n")) : null;
    if (card) cards.push(card);
    quote = [];
    continued = false;
  };
  for (const line of text.split(/\r\n|\r|\n/)) {
    const marker = FENCE.exec(line)?.[1];
    if (fence !== null) {
      if (marker?.startsWith(fence) && line.trim() === marker) {
        fence = null;
      }
      continue;
    }
    if (marker !== undefined) {
      flush();
      fence = marker;
    } else if (QUOTE_LINE.test(line)) {
      quote.push(line);
    } else if (line.trim().length === 0) {
      flush();
    } else if (quote.length > 0) {
      continued = true;
    }
  }
  flush();
  return cards;
}

const WITHDRAW_LINE = /^[ \t]*(Q[1-9][0-9]{0,5})[ \t]*:[ \t]*(.*?)[ \t]*$/;

/**
 * The card ids an assistant message withdraws: each whole `Qn: no longer needed` line. They apply
 * to the newest earlier message that asks cards; an answer the user gives still wins.
 */
export function questionWithdrawalsInMarkdown(text: string): ReadonlyArray<string> {
  if (!text.includes(QUESTION_WITHDRAWN_ANSWER)) return [];
  const ids: string[] = [];
  for (const line of text.split(/\r\n|\r|\n/)) {
    const match = WITHDRAW_LINE.exec(line);
    const id = match?.[1];
    if (id !== undefined && match?.[2] === QUESTION_WITHDRAWN_ANSWER && !ids.includes(id)) {
      ids.push(id);
    }
  }
  return ids;
}
