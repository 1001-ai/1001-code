import * as Schema from "effect/Schema";
import { findBackReferences } from "../../packages/shared/src/backReferences.ts";

export const BackReferencesExpect = Schema.Struct({
  /**
   * Earlier messages the final answer points back to: each needs a `(↑ "words")` marker of 3 to 8
   * words found in it, and every marker must quote one of them. Empty: no visible text has one.
   */
  points: Schema.Array(Schema.String),
});

// Chat's own matching (reLineMatchText in the web client): case, quote style, marks and spacing.
const normalized = (text: string) =>
  text
    .toLowerCase()
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/[*_`~>#]/g, "")
    .replace(/\s+/g, " ")
    .trim();

export const gradeBackReferences = (
  expect: typeof BackReferencesExpect.Type | undefined,
  run: { readonly text: string; readonly finalText?: string; readonly stopReason: string },
) => {
  if (expect === undefined) return [];
  if (expect.points.length === 0)
    return [{ check: "backReferences none", pass: !run.text.includes("(↑") }];
  const finalText = run.stopReason === "end_turn" ? (run.finalText ?? "") : "";
  const excerpts = findBackReferences(finalText).map((reference) => normalized(reference.excerpt));
  const messages = expect.points.map(normalized);
  const words = (excerpt: string) => excerpt.split(" ").length;
  return [
    ...messages.map((message, index) => ({
      check: `backReferences point to message ${index + 1}`,
      pass: excerpts.some(
        (excerpt) => words(excerpt) >= 3 && words(excerpt) <= 8 && message.includes(excerpt),
      ),
    })),
    {
      check: `backReferences every marker links (${excerpts.length})`,
      pass: excerpts.every((excerpt) => messages.some((message) => message.includes(excerpt))),
    },
  ];
};
