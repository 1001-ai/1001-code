import type { ComposerContextId } from "@t3tools/contracts";
import { formatComposerContextHref } from "@t3tools/shared/composerContextReferences";
import {
  QUESTION_MULTI_SEPARATOR,
  answerOnLine,
  questionCardsInMarkdown,
  questionQuoteSourcesInMarkdown,
  readAnswerLine,
  questionWithdrawalsInMarkdown,
  type QuestionBlock,
  type QuestionQuoteMatch,
} from "@t3tools/shared/questionCards";
import type { Element, ElementContent, Root } from "hast";

const BOOLEAN_OPTIONS = ["Yes", "No"] as const;

export function questionOptions(question: QuestionBlock): ReadonlyArray<string> {
  if (question.kind === "boolean") return BOOLEAN_OPTIONS;
  return question.options ?? [];
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
    readonly streaming?: unknown;
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

const cardsByItem = new WeakMap<object, ReadonlyArray<QuestionBlock>>();

function cardsOfItem(item: object, text: string): ReadonlyArray<QuestionBlock> {
  let cards = cardsByItem.get(item);
  if (cards === undefined) {
    cards = questionCardsInMarkdown(text);
    cardsByItem.set(item, cards);
  }
  return cards;
}

const hasQuestionCardsByMessage = new WeakMap<object, boolean>();

/**
 * Whether a finished assistant message asks question cards, so timeline folding and Zen mode
 * keep the message visible when later messages arrive in the same run.
 */
export function messageHasQuestionCards(message: {
  readonly role: string;
  readonly text: string;
  readonly streaming: boolean;
}): boolean {
  if (message.role !== "assistant" || message.streaming) return false;
  let has = hasQuestionCardsByMessage.get(message);
  if (has === undefined) {
    has = questionCardsInMarkdown(message.text).length > 0;
    hasQuestionCardsByMessage.set(message, has);
  }
  return has;
}

/**
 * Whether the agent withdrew `questionId` with a `<id>: no longer needed` line in a finished
 * assistant message after the item that asked it, while that item still held its latest cards,
 * and no user message answers it, before or after. Queued answers are `findQuestionAnswer`'s.
 */
export function isQuestionWithdrawn(
  items: ReadonlyArray<TurnItemLike>,
  askedInItemId: string,
  questionId: string,
): boolean {
  const askedAt = items.findIndex((entry) => entry.item.id === askedInItemId);
  if (askedAt < 0) return false;
  let withdrawn = false;
  // A message that asks cards takes over every later withdrawal.
  let superseded = false;
  for (let index = askedAt + 1; index < items.length; index += 1) {
    const { item } = items[index]!;
    const { type, text, streaming } = item;
    if (typeof text !== "string") continue;
    if (type === "user_message") {
      if (readAnswerLine(text, questionId) !== null) return false;
    } else if (type === "assistant_message" && streaming !== true && !superseded) {
      withdrawn ||= questionWithdrawalsInMarkdown(text).includes(questionId);
      superseded = cardsOfItem(item, text).length > 0;
    }
  }
  return withdrawn;
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
    for (const card of cardsOfItem(item, text))
      latest.set(card.id, { messageId, prompt: card.prompt });
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

function isQuestionHeader(node: Element): boolean {
  const [first] = node.children;
  return first?.type === "text" && QUESTION_HEADER_TEXT.test(first.value);
}

function hastPlainText(node: ElementContent): string {
  if (node.type === "text") return node.value;
  if (node.type !== "element") return "";
  let text = "";
  for (const child of node.children) text += hastPlainText(child);
  return text;
}

function containsReplyHint(node: Element): boolean {
  for (const child of node.children) {
    if (child.type !== "element") continue;
    if (child.tagName === "em" && hastPlainText(child).startsWith("Reply with ")) return true;
    if (containsReplyHint(child)) return true;
  }
  return false;
}

function blockquoteMatchesQuestion(blockquote: Element, match: QuestionQuoteMatch): boolean {
  const blocks = blockquote.children.filter((child): child is Element => child.type === "element");
  const firstBlock = blocks[0];
  if (!firstBlock || firstBlock.tagName !== "p") return false;
  const header = firstBlock.children[0];
  if (header?.type !== "element" || header.tagName !== "strong") return false;
  if (!hastPlainText(header).startsWith(`${match.card.id} · `)) return false;

  const list = blocks.find((block) => block.tagName === "ul");
  if (match.card.kind === "text") {
    return list === undefined && containsReplyHint(blockquote);
  }
  if (!list) return false;
  const items = list.children.filter(
    (child): child is Element => child.type === "element" && child.tagName === "li",
  );
  const expectedCount = match.card.kind === "boolean" ? 2 : (match.card.options?.length ?? 0);
  if (items.length !== expectedCount) return false;
  for (const item of items) {
    const start = item.position?.start.offset;
    const end = item.position?.end.offset;
    if (start !== undefined && end !== undefined && (start < match.start || end > match.end)) {
      return false;
    }
  }
  return true;
}

/**
 * Marks top-level question blockquotes in Words' hast with their markdown source so
 * `ChatMarkdown` renders them as question-card islands without needing blockquote positions.
 */
export function attachQuestionQuoteSources(tree: Root, source: string): void {
  const matches = questionQuoteSourcesInMarkdown(source);
  if (matches.length === 0) return;
  let cursor = 0;
  for (const child of tree.children) {
    if (cursor >= matches.length) break;
    if (
      child.type !== "element" ||
      child.tagName !== "blockquote" ||
      child.properties.dataAlert !== undefined
    ) {
      continue;
    }
    for (let index = cursor; index < matches.length; index++) {
      const match = matches[index]!;
      if (!blockquoteMatchesQuestion(child, match)) continue;
      child.properties.dataQuestionSource = match.source;
      cursor = index + 1;
      break;
    }
  }
}

/**
 * Turns each question id in prose into a `t3-context` link that `renderContextReference` renders.
 * Code, links, math SVG and a card's own `**Q4 · prompt**` line are skipped.
 */
export function hastQuestionRefs(tree: Root): void {
  const visit = (node: Root | Element) => {
    if (
      node.type === "element" &&
      (node.tagName === "a" ||
        node.tagName === "code" ||
        node.tagName === "pre" ||
        node.tagName === "svg" ||
        (node.tagName === "strong" && isQuestionHeader(node)))
    ) {
      return;
    }
    const children = node.children as ElementContent[];
    for (let index = 0; index < children.length; index++) {
      const child = children[index]!;
      if (child.type === "element") {
        visit(child);
        continue;
      }
      if (child.type !== "text") continue;
      const refs = findQuestionRefs(child.value);
      if (refs.length === 0) continue;
      const parts: ElementContent[] = [];
      let offset = 0;
      for (const { id, start, end } of refs) {
        if (start > offset) parts.push({ type: "text", value: child.value.slice(offset, start) });
        parts.push({
          type: "element",
          tagName: "a",
          properties: {
            href: formatComposerContextHref(QUESTION_REF_KIND, id as ComposerContextId),
          },
          children: [{ type: "text", value: id }],
        });
        offset = end;
      }
      if (offset < child.value.length) {
        parts.push({ type: "text", value: child.value.slice(offset) });
      }
      children.splice(index, 1, ...parts);
      index += parts.length - 1;
    }
  };
  visit(tree);
}
