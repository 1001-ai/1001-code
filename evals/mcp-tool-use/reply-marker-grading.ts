import * as Schema from "effect/Schema";
import { splitReLines } from "../../packages/shared/src/replyMarkers.ts";

export const ReplyMarkersExpect = Schema.Struct({
  /**
   * The user messages the final answer answers, in the order sent: it opens with one `Re:` line
   * for each, as chat parses them. Empty: no visible text in the sample has a `Re:` line.
   */
  answers: Schema.Array(Schema.String),
});

const normalized = (text: string) => text.toLowerCase().replace(/\s+/g, " ").trim();
const ANY_RE_LINE = /^[\s>*_-]*Re:/m;

export const gradeReplyMarkers = (
  expect: typeof ReplyMarkersExpect.Type | undefined,
  run: { readonly text: string; readonly finalText?: string; readonly stopReason: string },
) => {
  if (expect === undefined) return [];
  if (expect.answers.length === 0)
    return [{ check: "replyMarkers none", pass: !ANY_RE_LINE.test(run.text) }];
  const finalText = run.stopReason === "end_turn" ? (run.finalText ?? "") : "";
  const lines = splitReLines(finalText)?.lines ?? [];
  const messages = expect.answers.map(normalized);
  return [
    {
      check: `replyMarkers ${messages.length} lines (${lines.length})`,
      pass: lines.length === messages.length,
    },
    ...messages.map((message, index) => {
      const excerpt = normalized(lines[index]?.excerpt ?? "");
      const words = excerpt === "" ? 0 : excerpt.split(" ").length;
      const only = messages.every((other, at) => at === index || !other.includes(excerpt));
      return {
        check: `replyMarkers line ${index + 1} quotes message ${index + 1}: "${excerpt}"`,
        pass: words >= 3 && words <= 8 && message.includes(excerpt) && only,
      };
    }),
  ];
};
