import { setLiveAppCheckout } from "@t3tools/provider-core/server/runtimeInstructions";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/** Builds T3's text as a server in dev mode from `checkout` would send it. */
export const withLiveAppCheckout = <A, E, R>(
  checkout: string | undefined,
  build: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  checkout === undefined
    ? build
    : Effect.acquireUseRelease(
        Effect.sync(() => setLiveAppCheckout(checkout)),
        () => build,
        () => Effect.sync(() => setLiveAppCheckout(undefined)),
      );

/** Regexes that shell commands match in this order, each after the command the one before matched. */
export const ShellInOrderExpect = Schema.Array(Schema.String);

export const gradeShellInOrder = (
  patterns: typeof ShellInOrderExpect.Type | undefined,
  shell: ReadonlyArray<string>,
) => {
  if (patterns === undefined) return [];
  let from = 0;
  for (const pattern of patterns) {
    const regex = new RegExp(pattern);
    const at = shell.findIndex((command, index) => index >= from && regex.test(command));
    if (at === -1) return [{ check: `shellInOrder ${patterns.join(" -> ")}`, pass: false }];
    // One command may satisfy consecutive patterns: `git status && git apply`.
    from = at;
  }
  return [{ check: `shellInOrder ${patterns.join(" -> ")}`, pass: true }];
};
