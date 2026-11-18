import { assert, it } from "@effect/vitest";

import { gradeBackReferences } from "./back-reference-grading.ts";

const earlier =
  "Two risks before launch:\n1. The **session token** expires after one hour, so long uploads fail.\n2. The export job has no retry.";
const grade = (
  points: ReadonlyArray<string>,
  finalText: string,
  stopReason = "end_turn",
  history: ReadonlyArray<string> = [],
) => gradeBackReferences({ points }, { text: finalText, finalText, stopReason }, history);
const passes = (points: ReadonlyArray<string>, finalText: string, stopReason = "end_turn") =>
  grade(points, finalText, stopReason).every((check) => check.pass);

it("passes a marker that quotes the earlier message", () => {
  assert.isTrue(
    passes([earlier], 'Fix the token first (↑ "session token expires after one hour").'),
  );
  assert.isTrue(passes([earlier], "Fix the token first (↑ “The session token expires”)."));
  assert.isFalse(
    passes([earlier], 'Fix it (↑ "session token expires after one hour").', "max_steps"),
    "a turn that never ended",
  );
});

it("fails no marker, a paraphrase, a long quote, or an extra invented marker", () => {
  for (const reply of [
    "Fix the session token expiry first.",
    'Fix it (↑ "the token runs out after an hour").',
    'Fix it (↑ "The session token expires after one hour, so long uploads fail").',
    'Fix it (↑ "session token expires after one hour") (↑ "as we agreed yesterday").',
  ])
    assert.isFalse(passes([earlier], reply), reply);
});

it("reports whether each marker is in the chat history exactly or as a close match", () => {
  const history = ["Review src/upload.ts for anything that could break at launch.", earlier];
  const checks = grade(
    [earlier],
    'Fix it (↑ "session token expires after an hour") before you (↑ "review src/upload.ts for anything").',
    "end_turn",
    history,
  );
  const markers = checks.filter((check) => check.check.includes("in chat history"));
  assert.deepStrictEqual(
    markers.map((check) => check.check.match(/\((\w+)\)/)?.[1]),
    ["close", "exact"],
  );
  assert.isTrue(markers.every((check) => check.pass));
  assert.isTrue(checks.find((check) => check.check.endsWith("message 1"))!.pass);
  assert.isFalse(checks.find((check) => check.check.includes("every marker links"))!.pass);
  const invented = grade([earlier], 'See (↑ "as we agreed yesterday").', "end_turn", history);
  assert.isTrue(invented.some((check) => check.check.includes("(none)") && !check.pass));
});

it("fails a control when any visible text has a marker", () => {
  assert.isTrue(passes([], "batchSize defaults to 500."));
  assert.isFalse(passes([], 'It defaults to 500 (↑ "the default batch size").'));
});
