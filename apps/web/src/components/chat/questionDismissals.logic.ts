import { questionDismissalText } from "@t3tools/shared/questionCards";
import { create } from "zustand";

/** How long a dismissed card offers Undo before the dismissal is recorded. */
export const QUESTION_DISMISS_UNDO_MS = 5_000;

/** `pending` while Undo is offered; `recorded` once the message is on its way or stored. */
export type QuestionDismissalState = "pending" | "recorded";

export const useQuestionDismissalStore = create<{
  readonly cards: Readonly<Record<string, QuestionDismissalState>>;
}>(() => ({ cards: {} }));

interface Batch {
  readonly cards: Map<string, string>;
  readonly record: (text: string) => Promise<boolean>;
  readonly timer: ReturnType<typeof setTimeout>;
}

// One pending batch per thread, so dismissals inside the Undo window share one message.
const batches = new Map<string, Batch>();

function setCards(cardKeys: Iterable<string>, state: QuestionDismissalState | null) {
  useQuestionDismissalStore.setState(({ cards }) => {
    const next = { ...cards };
    for (const cardKey of cardKeys) {
      if (state === null) delete next[cardKey];
      else next[cardKey] = state;
    }
    return { cards: next };
  });
}

async function recordBatch(threadKey: string) {
  const batch = batches.get(threadKey);
  if (batch === undefined) return;
  batches.delete(threadKey);
  setCards(batch.cards.keys(), "recorded");
  const recorded = await batch.record(questionDismissalText([...new Set(batch.cards.values())]));
  if (!recorded) setCards(batch.cards.keys(), null);
}

/**
 * Dismisses a card after the Undo window. Each dismissal in the thread restarts the window, and
 * `record` (the latest one given) sends the batch's `Qn: dismissed` lines as one message.
 */
export function dismissQuestionCard(input: {
  readonly threadKey: string;
  readonly cardKey: string;
  readonly questionId: string;
  readonly record: (text: string) => Promise<boolean>;
}) {
  const previous = batches.get(input.threadKey);
  if (previous !== undefined) clearTimeout(previous.timer);
  const cards = previous?.cards ?? new Map<string, string>();
  cards.set(input.cardKey, input.questionId);
  batches.set(input.threadKey, {
    cards,
    record: input.record,
    timer: setTimeout(() => void recordBatch(input.threadKey), QUESTION_DISMISS_UNDO_MS),
  });
  setCards([input.cardKey], "pending");
}

/** Takes a dismissal back while its Undo window is open. */
export function undoQuestionDismissal(threadKey: string, cardKey: string) {
  const batch = batches.get(threadKey);
  if (batch === undefined || !batch.cards.delete(cardKey)) return;
  setCards([cardKey], null);
  if (batch.cards.size === 0) {
    clearTimeout(batch.timer);
    batches.delete(threadKey);
  }
}
