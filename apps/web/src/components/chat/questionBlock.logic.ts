const BOOLEAN_OPTIONS = ["Yes", "No"] as const;
const MULTI_SEPARATOR = ", ";

export interface QuestionBlock {
  readonly id: string;
  readonly prompt: string;
  readonly kind: "choice" | "multi" | "boolean" | "text";
  /** Set for `choice` and `multi` only. */
  readonly options?: ReadonlyArray<string>;
  readonly recommended?: string;
}

export function questionOptions(question: QuestionBlock): ReadonlyArray<string> {
  if (question.kind === "boolean") return BOOLEAN_OPTIONS;
  return question.options ?? [];
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
    if (options.some((option) => option.includes(MULTI_SEPARATOR))) return null;
    return { id, prompt, kind: "multi", options, ...recommendation };
  }
  if (options.length === 2 && options[0] === "Yes" && options[1] === "No") {
    return { id, prompt, kind: "boolean", ...recommendation };
  }
  return { id, prompt, kind: "choice", options, ...recommendation };
}

const ANSWER_LINE = /^[ \t]*([A-Za-z][A-Za-z0-9_-]*)[ \t]*:[ \t]*(.*?)[ \t]*$/;

function answerOnLine(line: string, id: string): string | null {
  const match = ANSWER_LINE.exec(line);
  return match?.[1] === id ? (match[2] ?? "") : null;
}

/** The answer a `<id>: answer` line in `text` gives, or null when no line answers it. */
export function readAnswerLine(text: string, id: string): string | null {
  for (const line of text.split("\n")) {
    const answer = answerOnLine(line, id);
    if (answer !== null && answer.length > 0) return answer;
  }
  return null;
}

/** Writes `<id>: answer` into the draft, replacing that question's line; null removes it. */
export function writeAnswerLine(prompt: string, id: string, answer: string | null): string {
  const lines = prompt.split("\n");
  const index = lines.findIndex((line) => answerOnLine(line, id) !== null);
  const value = answer?.trim() ?? "";
  if (value.length === 0) {
    if (index < 0) return prompt;
    lines.splice(index, 1);
    return lines.join("\n");
  }
  const line = `${id}: ${value}`;
  if (index >= 0) {
    lines[index] = line;
    return lines.join("\n");
  }
  if (prompt.trim().length === 0) return line;
  return prompt.endsWith("\n") ? `${prompt}${line}` : `${prompt}\n${line}`;
}

/** The options a multi answer selects, read back from its draft line. */
export function selectedMultiOptions(
  options: ReadonlyArray<string>,
  answer: string | null,
): ReadonlySet<string> {
  if (answer === null) return new Set();
  const parts = new Set(answer.split(MULTI_SEPARATOR));
  return new Set(options.filter((option) => parts.has(option)));
}

export function toggleMultiOption(
  options: ReadonlyArray<string>,
  answer: string | null,
  option: string,
): string | null {
  const selected = new Set(selectedMultiOptions(options, answer));
  if (selected.has(option)) selected.delete(option);
  else selected.add(option);
  const next = options.filter((candidate) => selected.has(candidate));
  return next.length === 0 ? null : next.join(MULTI_SEPARATOR);
}

interface TurnItemLike {
  readonly item: {
    readonly id: string;
    readonly type: string;
    readonly text?: unknown;
    readonly messageId?: string;
  };
}

export interface QuestionAnswer {
  readonly answer: string;
  /** The user message whose `<id>: answer` line gave it. */
  readonly messageId: string;
}

/**
 * The most recent answer to `questionId` in a user message after the item that asked it.
 * Answers are never stored; a later `<id>: answer` line is the answer.
 */
export function findQuestionAnswer(
  items: ReadonlyArray<TurnItemLike>,
  askedInItemId: string,
  questionId: string,
): QuestionAnswer | null {
  const askedAt = items.findIndex((entry) => entry.item.id === askedInItemId);
  if (askedAt < 0) return null;
  for (let index = items.length - 1; index > askedAt; index -= 1) {
    const { type, text, messageId } = items[index]!.item;
    if (type !== "user_message" || typeof text !== "string" || messageId === undefined) continue;
    const answer = readAnswerLine(text, questionId);
    if (answer !== null) return { answer, messageId };
  }
  return null;
}
