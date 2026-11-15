import type { ComposerContextId } from "@t3tools/contracts";
import { formatComposerContextHref } from "@t3tools/shared/composerContextReferences";
import {
  QUESTION_MULTI_SEPARATOR,
  questionCardsInMarkdown,
  type QuestionBlock,
} from "@t3tools/shared/questionCards";
import type { PhrasingContent, Root, RootContent, Strong } from "mdast";

const BOOLEAN_OPTIONS = ["Yes", "No"] as const;

export function questionOptions(question: QuestionBlock): ReadonlyArray<string> {
  if (question.kind === "boolean") return BOOLEAN_OPTIONS;
  return question.options ?? [];
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
  const parts = new Set(answer.split(QUESTION_MULTI_SEPARATOR));
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
  return next.length === 0 ? null : next.join(QUESTION_MULTI_SEPARATOR);
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

interface QueuedMessageLike {
  readonly text: string;
  readonly messageId: string;
}

/**
 * The most recent answer to `questionId` in a user message after the item that asked it,
 * counting messages still queued, which come after every turn item. Answers are never stored;
 * a later `<id>: answer` line is the answer.
 */
export function findQuestionAnswer(
  items: ReadonlyArray<TurnItemLike>,
  askedInItemId: string,
  questionId: string,
  queued: ReadonlyArray<QueuedMessageLike> = [],
): QuestionAnswer | null {
  const askedAt = items.findIndex((entry) => entry.item.id === askedInItemId);
  if (askedAt < 0) return null;
  for (let index = queued.length - 1; index >= 0; index -= 1) {
    const { text, messageId } = queued[index]!;
    const answer = readAnswerLine(text, questionId);
    if (answer !== null) return { answer, messageId };
  }
  for (let index = items.length - 1; index > askedAt; index -= 1) {
    const { type, text, messageId } = items[index]!.item;
    if (type !== "user_message" || typeof text !== "string" || messageId === undefined) continue;
    const answer = readAnswerLine(text, questionId);
    if (answer !== null) return { answer, messageId };
  }
  return null;
}

// An id the way prose mentions it: `(Q40)`, `Q40,` or `Q40:`, but not `Q40a`, `FAQ40` or `Q0`.
const QUESTION_REF = /(?<![\p{L}\p{N}_])Q[1-9][0-9]{0,5}(?![\p{L}\p{N}_])/gu;

/** The question ids `text` mentions, in order. */
export function findQuestionRefs(
  text: string,
): ReadonlyArray<{ readonly id: string; readonly start: number; readonly end: number }> {
  return Array.from(text.matchAll(QUESTION_REF), (match) => ({
    id: match[0],
    start: match.index,
    end: match.index + match[0].length,
  }));
}

interface MessageItemLike<M extends string> {
  readonly item: {
    readonly type: string;
    readonly text?: unknown;
    readonly messageId?: M;
    readonly streaming?: unknown;
  };
}

export interface QuestionCardTarget<M extends string = string> {
  readonly messageId: M;
  readonly prompt: string;
}

const cardsByItem = new WeakMap<object, ReadonlyArray<QuestionBlock>>();

/**
 * Each question id's newest card among finished assistant messages. A re-asked question keeps its
 * id, so the newest card is the live one. Parses each message once.
 */
export function latestQuestionCards<M extends string>(
  items: ReadonlyArray<MessageItemLike<M>>,
): ReadonlyMap<string, QuestionCardTarget<M>> {
  const latest = new Map<string, QuestionCardTarget<M>>();
  for (const { item } of items) {
    const { type, text, messageId, streaming } = item;
    if (type !== "assistant_message" || typeof text !== "string" || messageId === undefined) {
      continue;
    }
    // A streaming message shows its quotes as written, so it has no card to land on yet.
    if (streaming === true) continue;
    let cards = cardsByItem.get(item);
    if (cards === undefined) {
      cards = questionCardsInMarkdown(text);
      cardsByItem.set(item, cards);
    }
    for (const card of cards) latest.set(card.id, { messageId, prompt: card.prompt });
  }
  return latest;
}

export function sameQuestionCardTargets(
  left: ReadonlyMap<string, QuestionCardTarget>,
  right: ReadonlyMap<string, QuestionCardTarget>,
): boolean {
  if (left.size !== right.size) return false;
  for (const [id, target] of left) {
    const other = right.get(id);
    if (other?.messageId !== target.messageId || other.prompt !== target.prompt) return false;
  }
  return true;
}

/** The context kind a question mention renders through `renderContextReference`. */
export const QUESTION_REF_KIND = "question";

const QUESTION_HEADER_TEXT = /^Q[1-9][0-9]{0,5} · /;

function isQuestionHeader(node: Strong): boolean {
  const [first] = node.children;
  return first?.type === "text" && QUESTION_HEADER_TEXT.test(first.value);
}

/**
 * Turns each question id in prose into a `t3-context` link that `renderContextReference` renders.
 * Code is not text, so it keeps its ids; links and a card's own `**Q4 · prompt**` line are skipped.
 */
export function remarkQuestionRefs() {
  return (tree: Root) => {
    const visit = (node: Root | RootContent) => {
      if (!("children" in node) || node.type === "link" || node.type === "linkReference") return;
      if (node.type === "strong" && isQuestionHeader(node)) return;
      node.children = node.children.flatMap((child): typeof node.children => {
        if (child.type !== "text") {
          visit(child);
          return [child];
        }
        const refs = findQuestionRefs(child.value);
        if (refs.length === 0) return [child];
        const parts: PhrasingContent[] = [];
        let offset = 0;
        for (const { id, start, end } of refs) {
          if (start > offset) parts.push({ type: "text", value: child.value.slice(offset, start) });
          parts.push({
            type: "link",
            url: formatComposerContextHref(QUESTION_REF_KIND, id as ComposerContextId),
            children: [{ type: "text", value: id }],
          });
          offset = end;
        }
        if (offset < child.value.length)
          parts.push({ type: "text", value: child.value.slice(offset) });
        return parts;
      });
    };
    visit(tree);
  };
}
