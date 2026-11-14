import { describe, expect, it } from "vite-plus/test";

import { hasUnseenQuestions, withUnseenQuestions } from "./threadQuestions.ts";

const asked = "2026-06-01T00:00:05.000Z";

describe("hasUnseenQuestions", () => {
  it.each([
    ["no questions", { openQuestionsAt: null, lastVisitedAt: null }, false],
    ["an older server", {}, false],
    ["a thread nobody opened", { openQuestionsAt: asked, lastVisitedAt: null }, true],
    [
      "a visit before the questions",
      { openQuestionsAt: asked, lastVisitedAt: "2026-06-01T00:00:04.000Z" },
      true,
    ],
    ["a visit at the questions", { openQuestionsAt: asked, lastVisitedAt: asked }, false],
    [
      "a visit after the questions",
      { openQuestionsAt: asked, lastVisitedAt: "2026-06-01T00:00:06.000Z" },
      false,
    ],
  ])("reads %s", (_name, thread, expected) => {
    expect(hasUnseenQuestions(thread)).toBe(expected);
  });
});

describe("withUnseenQuestions", () => {
  const unseen = { openQuestionsAt: asked, lastVisitedAt: null };
  it.each([
    ["preparing", "input"],
    ["working", "input"],
    ["waiting", "input"],
    ["ready", "ready"],
    ["approval", "approval"],
    ["failed", "failed"],
  ])("shows a %s thread as %s", (status, expected) => {
    expect(withUnseenQuestions(status, unseen)).toBe(expected);
  });

  it("leaves a thread whose questions were read alone", () => {
    expect(withUnseenQuestions("working", { openQuestionsAt: asked, lastVisitedAt: asked })).toBe(
      "working",
    );
  });
});
