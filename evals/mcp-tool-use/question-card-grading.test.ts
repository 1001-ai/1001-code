import { assert, it } from "@effect/vitest";

import { gradeQuestionCards } from "./question-card-grading.ts";

const choice = "> **Q1 · Which name?**\n>\n> - app.config.json _(recommended)_\n> - settings.json";
const yesNo = "> **Q2 · Run the rebuild now?**\n>\n> - Yes\n> - No";
const passes = (
  kind: "choice" | "boolean" | "none",
  run: { text: string; finalText?: string; stopReason?: string },
) => gradeQuestionCards({ kind }, { stopReason: "end_turn", ...run }).every((check) => check.pass);

it("passes a final answer with a card of the expected kind, as chat parses it", () => {
  assert.isTrue(passes("choice", { text: choice, finalText: `Context first.\n\n${choice}` }));
  assert.isTrue(passes("boolean", { text: yesNo, finalText: yesNo }));
  assert.isFalse(passes("boolean", { text: choice, finalText: choice }));
  // Yes and No in the other order is a plain choice, not a confirmation.
  const noYes = "> **Q2 · Run it?**\n>\n> - No\n> - Yes";
  assert.isFalse(passes("boolean", { text: noYes, finalText: noYes }));
});

it("fails text chat would not render as a card", () => {
  const prose = "Which name should it have: app.config.json or settings.json?";
  const notBold = "> Q1 · Which name?\n>\n> - app.config.json\n> - settings.json";
  const fenced = `\`\`\`md\n${choice}\n\`\`\``;
  for (const finalText of [prose, notBold, fenced])
    assert.isFalse(passes("choice", { text: finalText, finalText }));
  assert.isFalse(
    passes("choice", { text: choice, finalText: choice, stopReason: "max_steps" }),
    "a turn that never ended has no final answer",
  );
});

it("fails a control when any visible text has a card", () => {
  assert.isTrue(passes("none", { text: "Added export-worker.config.json.", finalText: "Done." }));
  assert.isFalse(passes("none", { text: `Checking.\n\n${choice}\n\nDone.`, finalText: "Done." }));
});
