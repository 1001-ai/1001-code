import type { MessageId } from "@t3tools/contracts";
import {
  openQuestionCards,
  questionCardsInMarkdown,
  readAnswerLine,
  type QuestionBlock,
} from "@t3tools/shared/questionCards";

import { writeAnswerLine } from "../chat/questionBlock.logic";

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
  };
}

export interface OpenQuestionCard {
  readonly question: QuestionBlock;
  /** The assistant item whose markdown asked it. */
  readonly askedInItemId: string;
  readonly messageId: MessageId;
}

export interface ThreadQuestionCards {
  /** The loaded history asks cards, answered or not. */
  readonly asked: boolean;
  readonly open: ReadonlyArray<OpenQuestionCard>;
}

const cardsByItem = new WeakMap<object, ReadonlyArray<QuestionBlock>>();

/** The thread's open cards by the shared rule the server's `openQuestionsAt` also runs. */
export function threadQuestionCards(items: ReadonlyArray<TimelineItemLike>): ThreadQuestionCards {
  const messages = items.flatMap(({ item }) => {
    const { type, text, messageId } = item;
    if (typeof text !== "string") return [];
    if (type === "user_message") return [{ role: "user", text, item, messageId }];
    if (type !== "assistant_message" || messageId === undefined) return [];
    return [{ role: "assistant", text, streaming: item.streaming === true, item, messageId }];
  });
  let asked = false;
  const open = openQuestionCards(messages, ({ item, text }) => {
    let cards = cardsByItem.get(item);
    if (cards === undefined) {
      cards = questionCardsInMarkdown(text);
      cardsByItem.set(item, cards);
    }
    asked ||= cards.length > 0;
    return cards;
  });
  return {
    asked,
    open: open.flatMap(({ question, message }) =>
      message.messageId === undefined
        ? []
        : [{ question, askedInItemId: message.item.id, messageId: message.messageId }],
    ),
  };
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

export type QuestionsFilter = "all" | "questions" | "approvals" | "memories";

export interface WaitingEntryInput {
  readonly shell: Pick<
    WaitingShellInput,
    "openQuestionsAt" | "hasPendingApprovals" | "hasPendingUserInput"
  >;
  readonly loaded: boolean;
  /** The loaded history asks cards, even if all are answered. */
  readonly cardsAsked: boolean;
  readonly cards: ReadonlyArray<unknown>;
  readonly requests: {
    readonly approvals: ReadonlyArray<unknown>;
    readonly userInputs: ReadonlyArray<{ readonly questions: ReadonlyArray<unknown> }>;
  };
  /** Unanswered memory proposals from the thread's agents; known without loading the thread. */
  readonly proposals: ReadonlyArray<unknown>;
}

export interface WaitingSummary {
  readonly questions: number;
  readonly approvals: number;
  readonly memories: number;
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
  const memories = entry.proposals.length;
  const unshownQuestion =
    entry.loaded &&
    questions === 0 &&
    ((Boolean(entry.shell.openQuestionsAt) && !entry.cardsAsked) ||
      entry.shell.hasPendingUserInput);
  const unshownApproval = entry.loaded && approvals === 0 && entry.shell.hasPendingApprovals;
  const count =
    memories +
    (entry.loaded ? questions + approvals + Number(unshownQuestion) + Number(unshownApproval) : 1);
  return { questions, approvals, memories, unshownQuestion, unshownApproval, count };
}

/**
 * Whether a thread shows under a filter. One still loading shows under every filter but
 * Memories, whose proposals need no loading; one with nothing left waiting (cards answered before
 * the shell caught up) shows under none.
 */
export function matchesFilter(
  summary: WaitingSummary,
  loaded: boolean,
  filter: QuestionsFilter,
): boolean {
  if (filter === "memories") return summary.memories > 0;
  if (!loaded) return true;
  switch (filter) {
    case "all":
      return summary.count > 0;
    case "questions":
      return summary.questions > 0 || summary.unshownQuestion;
    case "approvals":
      return summary.approvals > 0 || summary.unshownApproval;
  }
}

export const ALL_PROJECTS = "all";

export interface ProjectOption {
  /** `${environmentId}:${projectId}` */
  readonly key: string;
  readonly title: string;
}

/** The projects that have something waiting, once each, by title. */
export function waitingProjectOptions(
  projects: ReadonlyArray<{ readonly key: string; readonly title: string | null }>,
): ReadonlyArray<ProjectOption> {
  const byKey = new Map<string, ProjectOption>();
  for (const { key, title } of projects) {
    if (!byKey.has(key)) byKey.set(key, { key, title: title ?? "Unknown project" });
  }
  return [...byKey.values()].toSorted(
    (left, right) => left.title.localeCompare(right.title) || left.key.localeCompare(right.key),
  );
}

/** The chosen project while it still has something waiting, else all projects. */
export function effectiveProjectFilter(
  selected: string,
  options: ReadonlyArray<ProjectOption>,
): string {
  return options.some((option) => option.key === selected) ? selected : ALL_PROJECTS;
}
