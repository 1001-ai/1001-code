import { MessageId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  matchesFilter,
  openQuestionCards,
  questionAnswersMessage,
  waitingSummary,
  withoutSentAnswerLines,
} from "./questionsPage.logic";

const at = (iso: string) => DateTime.makeUnsafe(iso);

function assistant(id: string, text: string, finishedAt: string, streaming = false) {
  return {
    item: {
      id,
      type: "assistant_message",
      messageId: MessageId.make(`m-${id}`),
      text,
      streaming,
      updatedAt: at(finishedAt),
    },
  };
}

function user(id: string, text: string, sentAt: string) {
  return {
    item: {
      id,
      type: "user_message",
      messageId: MessageId.make(`m-${id}`),
      text,
      updatedAt: at(sentAt),
    },
  };
}

const ASK_TWO =
  "Two things.\n\n> **Q1 · Ship it?**\n> - Yes\n> - No\n\n> **Q2 · Name?**\n> _Reply with a name_";

describe("waitingSummary", () => {
  const shell = { openQuestionsAt: null, hasPendingApprovals: false, hasPendingUserInput: false };
  const none = { approvals: [], userInputs: [] };
  const counted = (entry: Parameters<typeof waitingSummary>[0]) => {
    const summary = waitingSummary(entry);
    return {
      count: summary.count,
      questions: matchesFilter(summary, entry.loaded, "questions"),
      approvals: matchesFilter(summary, entry.loaded, "approvals"),
    };
  };
  it.each([
    [
      "cards, provider questions and approvals",
      {
        shell: { ...shell, openQuestionsAt: "2026-01-01T00:00:00.000Z", hasPendingApprovals: true },
        loaded: true,
        cards: [1, 2],
        requests: { approvals: [1], userInputs: [{ questions: [1, 2] }] },
      },
      { count: 5, questions: true, approvals: true },
    ],
    [
      "a thread still loading",
      { shell: { ...shell, hasPendingApprovals: true }, loaded: false, cards: [], requests: none },
      { count: 1, questions: true, approvals: true },
    ],
    [
      "cards outside the loaded history",
      {
        shell: { ...shell, openQuestionsAt: "2026-01-01T00:00:00.000Z" },
        loaded: true,
        cards: [],
        requests: none,
      },
      { count: 1, questions: true, approvals: false },
    ],
    [
      "a request kind the page does not render",
      {
        shell: { ...shell, hasPendingUserInput: true, hasPendingApprovals: true },
        loaded: true,
        cards: [],
        requests: none,
      },
      { count: 2, questions: true, approvals: true },
    ],
  ])("%s", (_label, entry, expected) => {
    expect(counted(entry)).toEqual(expected);
  });
});

describe("openQuestionCards", () => {
  const ids = (cards: ReturnType<typeof openQuestionCards>) =>
    cards.map((card) => [card.askedInItemId, card.question.id]);

  it("lists the cards asked after the user's latest message", () => {
    const items = [
      assistant("a1", "> **Q9 · Old?**\n> - Yes\n> - No", "2026-01-01T00:00:00.000Z"),
      user("u1", "Carry on", "2026-01-01T00:01:00.000Z"),
      assistant("a2", ASK_TWO, "2026-01-01T00:02:00.000Z"),
    ];
    expect(ids(openQuestionCards(items, "2026-01-01T00:01:00.000Z"))).toEqual([
      ["a2", "Q1"],
      ["a2", "Q2"],
    ]);
  });

  it("keeps a reply written while the asking message streamed", () => {
    const items = [
      assistant("a1", ASK_TWO, "2026-01-01T00:02:00.000Z"),
      user("u1", "Also check the tests", "2026-01-01T00:01:00.000Z"),
    ];
    expect(ids(openQuestionCards(items, "2026-01-01T00:01:00.000Z"))).toEqual([
      ["a1", "Q1"],
      ["a1", "Q2"],
    ]);
  });

  it("drops cards a later answer line answers", () => {
    const items = [
      assistant("a1", ASK_TWO, "2026-01-01T00:02:00.000Z"),
      user("u1", "Q1: Yes", "2026-01-01T00:01:00.000Z"),
    ];
    expect(ids(openQuestionCards(items, "2026-01-01T00:01:00.000Z"))).toEqual([["a1", "Q2"]]);
  });

  it("keeps only the newest card for a re-asked id, and skips streaming messages", () => {
    const items = [
      assistant("a1", ASK_TWO, "2026-01-01T00:02:00.000Z"),
      assistant("a2", "> **Q1 · Ship it now?**\n> - Yes\n> - No", "2026-01-01T00:03:00.000Z"),
      assistant("a3", "> **Q3 · Later?**\n> - Yes\n> - No", "2026-01-01T00:04:00.000Z", true),
    ];
    const cards = openQuestionCards(items, null);
    expect(ids(cards)).toEqual([
      ["a1", "Q2"],
      ["a2", "Q1"],
    ]);
    expect(cards[1]?.question.prompt).toBe("Ship it now?");
  });

  it("lists nothing once the user has written after the cards", () => {
    const items = [
      assistant("a1", ASK_TWO, "2026-01-01T00:02:00.000Z"),
      user("u1", "Never mind", "2026-01-01T00:03:00.000Z"),
    ];
    expect(openQuestionCards(items, "2026-01-01T00:03:00.000Z")).toEqual([]);
  });
});

describe("questionAnswersMessage", () => {
  it("sends the answer lines of the listed cards in card order, and nothing else", () => {
    const draft = "Some notes\nQ2: Ada\nQ7: elsewhere\nQ1: Yes";
    expect(questionAnswersMessage(draft, ["Q1", "Q2"])).toEqual({
      answers: [
        { id: "Q1", answer: "Yes" },
        { id: "Q2", answer: "Ada" },
      ],
      text: "Q1: Yes\nQ2: Ada",
    });
  });

  it("is null while no listed card has an answer", () => {
    expect(questionAnswersMessage("Q7: elsewhere\nQ1:", ["Q1", "Q2"])).toBeNull();
  });

  it("drops the sent lines once sent, keeping the rest and any line changed since", () => {
    const sent = [
      { id: "Q1", answer: "Yes" },
      { id: "Q2", answer: "Ada" },
    ];
    expect(withoutSentAnswerLines("Some notes\nQ2: Grace\nQ7: elsewhere\nQ1: Yes", sent)).toBe(
      "Some notes\nQ2: Grace\nQ7: elsewhere",
    );
  });
});
