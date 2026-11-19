import * as Schema from "effect/Schema";
import {
  findBackReferences,
  findQuotedMessage,
  markdownDisplayText,
  quoteWords,
} from "../../packages/shared/src/backReferences.ts";

export const BackReferencesExpect = Schema.Struct({
  /**
   * Earlier messages the final answer points back to: each needs a `(↑ "words")` marker of 3 to 8
   * words that chat links to it, and every marker must link to one of them. Empty: no visible text
   * has one.
   */
  points: Schema.Array(Schema.String),
});

const words = (excerpt: string) => excerpt.trim().split(/\s+/).length;

/**
 * `history` is the case's chat before the final answer: prior turns and the prompt. Markers are
 * matched the way chat links them (shared `findQuotedMessage`), exactly or as a close match.
 */
export const gradeBackReferences = (
  expect: typeof BackReferencesExpect.Type | undefined,
  run: { readonly text: string; readonly finalText?: string; readonly stopReason: string },
  history: ReadonlyArray<string> = [],
) => {
  if (expect === undefined) return [];
  if (expect.points.length === 0)
    return [{ check: "backReferences none", pass: !run.text.includes("(↑") }];
  const finalText = run.stopReason === "end_turn" ? (run.finalText ?? "") : "";
  const excerpts = findBackReferences(finalText).map((reference) => reference.excerpt);
  const shown = (text: string) => quoteWords(markdownDisplayText(text));
  const points = expect.points.map(shown);
  const chat = [...history, ...expect.points].map(shown);
  const pointOf = (excerpt: string) => findQuotedMessage(points, (point) => point, excerpt);
  return [
    ...points.map((point, index) => ({
      check: `backReferences point to message ${index + 1}`,
      pass: excerpts.some(
        (excerpt) =>
          words(excerpt) >= 3 && words(excerpt) <= 8 && pointOf(excerpt)?.message === point,
      ),
    })),
    {
      check: `backReferences every marker links (${excerpts.length})`,
      pass: excerpts.every((excerpt) => pointOf(excerpt) !== null),
    },
    ...excerpts.map((excerpt, index) => {
      const kind = findQuotedMessage(chat, (message) => message, excerpt)?.match.kind ?? "none";
      return {
        check: `backReferences marker ${index + 1} in chat history (${kind}): "${excerpt}"`,
        pass: kind !== "none",
      };
    }),
  ];
};
