import { assert, it } from "@effect/vitest";

import { gradeReplyMarkers } from "./reply-marker-grading.ts";

const first = "Add a --dry-run flag to scripts/cleanup.ts that prints what it would delete.";
const second = "Also make it skip anything under tmp/keep, we store fixtures there.";
const passes = (answers: ReadonlyArray<string>, finalText: string, stopReason = "end_turn") =>
  gradeReplyMarkers({ answers }, { text: finalText, finalText, stopReason }).every(
    (check) => check.pass,
  );

it("passes one Re: line per message, in order, each quoting its own message", () => {
  const reply = `**Re:** "a --dry-run flag to scripts/cleanup.ts"\n**Re:** "skip anything under TMP/keep"\n\nDone.`;
  assert.isTrue(passes([first, second], reply));
  const swapped = `**Re:** "skip anything under tmp/keep"\n**Re:** "a --dry-run flag to scripts/cleanup.ts"\n\nDone.`;
  assert.isFalse(passes([first, second], swapped));
  assert.isFalse(passes([first, second], `**Re:** "skip anything under tmp/keep"\n\nDone.`));
  assert.isFalse(passes([first, second], reply, "max_steps"), "a turn that never ended");
});

it("fails a quote chat would not link, or one outside 3 to 8 words", () => {
  const paraphrase = `**Re:** "add a dry run mode"\n**Re:** "skip anything under tmp/keep"\n\nDone.`;
  const ellipsis = `**Re:** "Add a --dry-run flag … delete"\n**Re:** "skip anything under tmp/keep"\n\nDone.`;
  const short = `**Re:** "dry-run"\n**Re:** "skip anything under tmp/keep"\n\nDone.`;
  const bulleted = `- **Re:** "a --dry-run flag to scripts/cleanup.ts"\n- **Re:** "skip anything under tmp/keep"\n\nDone.`;
  for (const reply of [paraphrase, ellipsis, short, bulleted])
    assert.isFalse(passes([first, second], reply));
});

it("fails a control when any visible text has a Re: line", () => {
  assert.isTrue(passes([], "batchSize defaults to 500."));
  assert.isFalse(passes([], `**Re:** "what does batchSize do"\n\nIt defaults to 500.`));
  assert.isFalse(passes([], `Checking.\n\nRe: batchSize\n\nIt defaults to 500.`));
});
