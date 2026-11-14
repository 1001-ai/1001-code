import * as Schema from "effect/Schema";
import { questionCardsInMarkdown } from "../../packages/shared/src/questionCards.ts";

export const QuestionCardsExpect = Schema.Struct({
  /**
   * The final answer has a card of this kind, as chat parses it. `none`: no visible text in the
   * sample has a card.
   */
  kind: Schema.Literals(["choice", "multi", "boolean", "text", "none"]),
});

export const gradeQuestionCards = (
  expect: typeof QuestionCardsExpect.Type | undefined,
  run: { readonly text: string; readonly finalText?: string; readonly stopReason: string },
) => {
  if (expect === undefined) return [];
  if (expect.kind === "none") {
    const kinds = questionCardsInMarkdown(run.text).map((card) => card.kind);
    return [
      {
        check: `questionCards none${kinds.length ? `: ${kinds.join(", ")}` : ""}`,
        pass: kinds.length === 0,
      },
    ];
  }
  const finalText = run.stopReason === "end_turn" ? (run.finalText ?? "") : "";
  const kinds = questionCardsInMarkdown(finalText).map((card) => card.kind);
  return [
    {
      check: `questionCards ${expect.kind} (${kinds.join(", ") || "no card"})`,
      pass: kinds.includes(expect.kind),
    },
  ];
};
