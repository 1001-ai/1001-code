import { assert, it } from "@effect/vitest";

import { gradeShellInOrder } from "./live-checkout.ts";

const passes = (shell: ReadonlyArray<string>) =>
  gradeShellInOrder(["status", "apply"], shell).every((check) => check.pass);

it("passes shell commands that match the patterns in order, one command for several included", () => {
  assert.isTrue(passes(["git status", "git diff | git apply"]));
  assert.isTrue(passes(["git status && git diff | git apply"]));
  assert.isFalse(passes(["git diff | git apply", "git status"]));
  assert.isFalse(passes(["git status"]));
  assert.deepStrictEqual(gradeShellInOrder(undefined, []), []);
});
