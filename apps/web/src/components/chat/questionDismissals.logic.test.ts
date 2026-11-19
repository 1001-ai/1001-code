import { describe, expect, it, vi } from "vite-plus/test";

import {
  QUESTION_DISMISS_UNDO_MS,
  dismissQuestionCard,
  undoQuestionDismissal,
  useQuestionDismissalStore,
} from "./questionDismissals.logic";

const cardsState = () => useQuestionDismissalStore.getState().cards;

describe("question dismissals", () => {
  it("records a thread's dismissals in one message after the Undo window, without the undone one", async () => {
    using _timers = { [Symbol.dispose]: () => vi.useRealTimers() };
    vi.useFakeTimers();
    const record = vi.fn(async (_text: string) => true);
    dismissQuestionCard({ threadKey: "t1", cardKey: "t1:a:Q45", questionId: "Q45", record });
    dismissQuestionCard({ threadKey: "t1", cardKey: "t1:a:Q46", questionId: "Q46", record });
    dismissQuestionCard({ threadKey: "t1", cardKey: "t1:a:Q47", questionId: "Q47", record });
    undoQuestionDismissal("t1", "t1:a:Q47");
    expect(cardsState()).toMatchObject({ "t1:a:Q45": "pending", "t1:a:Q46": "pending" });
    expect(cardsState()["t1:a:Q47"]).toBeUndefined();

    await vi.advanceTimersByTimeAsync(QUESTION_DISMISS_UNDO_MS - 1);
    expect(record).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(record.mock.calls).toEqual([["Q45: dismissed\nQ46: dismissed"]]);
    expect(cardsState()).toMatchObject({ "t1:a:Q45": "recorded", "t1:a:Q46": "recorded" });
  });

  it("sends nothing when every dismissal is undone, and reopens cards whose send failed", async () => {
    using _timers = { [Symbol.dispose]: () => vi.useRealTimers() };
    vi.useFakeTimers();
    const undone = vi.fn(async (_text: string) => true);
    dismissQuestionCard({ threadKey: "t2", cardKey: "t2:a:Q1", questionId: "Q1", record: undone });
    undoQuestionDismissal("t2", "t2:a:Q1");
    const failed = vi.fn(async (_text: string) => false);
    dismissQuestionCard({ threadKey: "t3", cardKey: "t3:a:Q1", questionId: "Q1", record: failed });
    await vi.advanceTimersByTimeAsync(QUESTION_DISMISS_UNDO_MS);
    expect(undone).not.toHaveBeenCalled();
    expect(failed.mock.calls).toEqual([["Q1: dismissed"]]);
    expect(cardsState()["t2:a:Q1"]).toBeUndefined();
    expect(cardsState()["t3:a:Q1"]).toBeUndefined();
  });
});
