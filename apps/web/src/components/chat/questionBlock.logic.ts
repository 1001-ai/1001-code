import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const BOOLEAN_OPTIONS = ["Yes", "No"] as const;

const QUESTION_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,23}$/;
// Line breaks would let one answer forge another `<id>:` line; invisible and bidi
// characters would make the draft say something other than what the card shows.
const VISIBLE_SINGLE_LINE = /^[^\p{Cc}\p{Cf}\u2028\u2029]*$/u;

const VisibleText = (max: number) =>
  Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(max),
    Schema.isTrimmed(),
    Schema.isPattern(VISIBLE_SINGLE_LINE),
  );

const QuestionBlockSchema = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(QUESTION_ID_PATTERN)),
  prompt: VisibleText(500),
  kind: Schema.Literals(["choice", "multi", "boolean", "text"]),
  options: Schema.optionalKey(
    Schema.Array(VisibleText(120)).check(
      Schema.isMinLength(2),
      Schema.isMaxLength(8),
      Schema.isUnique(),
    ),
  ),
  recommended: Schema.optionalKey(VisibleText(120)),
});

export type QuestionBlock = typeof QuestionBlockSchema.Type;

const decodeQuestionBlockJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(QuestionBlockSchema),
  { onExcessProperty: "error" },
);

export function questionOptions(question: QuestionBlock): ReadonlyArray<string> {
  if (question.kind === "boolean") return BOOLEAN_OPTIONS;
  return question.options ?? [];
}

const MULTI_SEPARATOR = ", ";

/** The fence body as a question, or null when it should render as ordinary code. */
export function parseQuestionBlock(code: string): QuestionBlock | null {
  if (code.length > 4_000) return null;
  const question = Option.getOrNull(decodeQuestionBlockJson(code));
  if (question === null) return null;
  const hasOptions = question.options !== undefined;
  const needsOptions = question.kind === "choice" || question.kind === "multi";
  if (hasOptions !== needsOptions) return null;
  // A multi answer joins options with the separator, so an option containing it can't round-trip.
  if (
    question.kind === "multi" &&
    questionOptions(question).some((o) => o.includes(MULTI_SEPARATOR))
  ) {
    return null;
  }
  if (
    question.recommended !== undefined &&
    (question.kind === "text" || !questionOptions(question).includes(question.recommended))
  ) {
    return null;
  }
  return question;
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
