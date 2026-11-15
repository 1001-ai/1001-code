import type { MessageId } from "@t3tools/contracts";
import { questionCardsInMarkdown, type QuestionBlock } from "@t3tools/shared/questionCards";
import * as DateTime from "effect/DateTime";

import { findQuestionAnswer, readAnswerLine, writeAnswerLine } from "../chat/questionBlock.logic";

export interface WaitingShellInput {
  readonly archivedAt: string | null;
  readonly deletedAt?: string | null;
  readonly openQuestionsAt?: string | null | undefined;
  readonly hasPendingApprovals: boolean;
  readonly hasPendingUserInput: boolean;
}

/** The shell says an agent waits on the user; only such threads get a detail subscription. */
export function isWaitingOnUser(shell: WaitingShellInput): boolean {
  if (shell.archivedAt !== null || (shell.deletedAt ?? null) !== null) return false;
  return Boolean(shell.openQuestionsAt) || shell.hasPendingApprovals || shell.hasPendingUserInput;
}

interface TimelineItemLike {
  readonly item: {
    readonly id: string;
    readonly type: string;
    readonly text?: unknown;
    readonly messageId?: MessageId;
    readonly streaming?: unknown;
    readonly updatedAt?: DateTime.Utc;
  };
}

export interface OpenQuestionCard {
  readonly question: QuestionBlock;
  /** The assistant item whose markdown asked it. */
  readonly askedInItemId: string;
  readonly messageId: MessageId;
}

const cardsByItem = new WeakMap<object, ReadonlyArray<QuestionBlock>>();

/**
 * The cards still waiting on the user: each id's newest card in a finished assistant message
 * that finished after the user's latest own message (the server's `openQuestionsAt` rule), and
 * that no later `<id>: answer` line answers.
 */
export function openQuestionCards(
  items: ReadonlyArray<TimelineItemLike>,
  latestUserAuthoredMessageAt: string | null,
): ReadonlyArray<OpenQuestionCard> {
  const repliedAt =
    latestUserAuthoredMessageAt === null ? null : Date.parse(latestUserAuthoredMessageAt);
  const newest = new Map<string, OpenQuestionCard>();
  for (const { item } of items) {
    const { type, text, messageId, streaming, updatedAt } = item;
    if (type !== "assistant_message" || typeof text !== "string" || messageId === undefined) {
      continue;
    }
    if (streaming === true) continue;
    if (
      repliedAt !== null &&
      !Number.isNaN(repliedAt) &&
      (updatedAt === undefined || DateTime.toEpochMillis(updatedAt) <= repliedAt)
    ) {
      continue;
    }
    let cards = cardsByItem.get(item);
    if (cards === undefined) {
      cards = questionCardsInMarkdown(text);
      cardsByItem.set(item, cards);
    }
    for (const question of cards) {
      // A re-asked id moves to where it was asked last.
      newest.delete(question.id);
      newest.set(question.id, { question, askedInItemId: item.id, messageId });
    }
  }
  return [...newest.values()].filter(
    (card) => findQuestionAnswer(items, card.askedInItemId, card.question.id) === null,
  );
}

export function sameOpenQuestionCards(
  left: ReadonlyArray<OpenQuestionCard>,
  right: ReadonlyArray<OpenQuestionCard>,
): boolean {
  return (
    left.length === right.length &&
    left.every((card, index) => {
      const other = right[index]!;
      return (
        card.askedInItemId === other.askedInItemId &&
        card.question.id === other.question.id &&
        card.question.prompt === other.question.prompt
      );
    })
  );
}

export interface QuestionAnswersMessage {
  readonly answers: ReadonlyArray<{ readonly id: string; readonly answer: string }>;
  /** One `<id>: answer` line per answered card, in card order. */
  readonly text: string;
}

/** The message that answers the cards whose answers the draft holds, or null when it holds none. */
export function questionAnswersMessage(
  draftPrompt: string,
  questionIds: ReadonlyArray<string>,
): QuestionAnswersMessage | null {
  const answers = questionIds.flatMap((id) => {
    const answer = readAnswerLine(draftPrompt, id);
    return answer === null ? [] : [{ id, answer }];
  });
  if (answers.length === 0) return null;
  return { answers, text: answers.map(({ id, answer }) => `${id}: ${answer}`).join("\n") };
}

/**
 * The draft once the sent answers' lines leave it. A line changed since the send stays, and so
 * does the rest of what the user typed.
 */
export function withoutSentAnswerLines(
  draftPrompt: string,
  sent: QuestionAnswersMessage["answers"],
): string {
  return sent.reduce(
    (prompt, { id, answer }) =>
      readAnswerLine(prompt, id) === answer ? writeAnswerLine(prompt, id, null) : prompt,
    draftPrompt,
  );
}

export interface WaitingEntryInput {
  readonly shell: Pick<
    WaitingShellInput,
    "openQuestionsAt" | "hasPendingApprovals" | "hasPendingUserInput"
  >;
  readonly loaded: boolean;
  readonly cards: ReadonlyArray<unknown>;
  readonly requests: {
    readonly approvals: ReadonlyArray<unknown>;
    readonly userInputs: ReadonlyArray<{ readonly questions: ReadonlyArray<unknown> }>;
  };
}

export interface WaitingSummary {
  readonly questions: number;
  readonly approvals: number;
  /**
   * The shell says a question or an approval waits that the page cannot show: cards outside the
   * loaded history, or a request kind it does not render (links, secrets, dynamic tool calls).
   */
  readonly unshownQuestion: boolean;
  readonly unshownApproval: boolean;
  /** Items in the header's count; a thread still loading counts one, as does each unshown kind. */
  readonly count: number;
}

export function waitingSummary(entry: WaitingEntryInput): WaitingSummary {
  const questions =
    entry.cards.length +
    entry.requests.userInputs.reduce((total, input) => total + input.questions.length, 0);
  const approvals = entry.requests.approvals.length;
  const unshownQuestion =
    entry.loaded &&
    questions === 0 &&
    (Boolean(entry.shell.openQuestionsAt) || entry.shell.hasPendingUserInput);
  const unshownApproval = entry.loaded && approvals === 0 && entry.shell.hasPendingApprovals;
  const count = entry.loaded
    ? questions + approvals + Number(unshownQuestion) + Number(unshownApproval)
    : 1;
  return { questions, approvals, unshownQuestion, unshownApproval, count };
}

/** Whether a thread shows under a filter; one still loading shows under all of them. */
export function matchesFilter(
  summary: WaitingSummary,
  loaded: boolean,
  filter: "all" | "questions" | "approvals",
): boolean {
  if (filter === "all" || !loaded) return true;
  return filter === "questions"
    ? summary.questions > 0 || summary.unshownQuestion
    : summary.approvals > 0 || summary.unshownApproval;
}
