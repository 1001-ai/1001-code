import { assert, describe, it } from "@effect/vitest";

import { liveAppCheckoutCodexContext, setLiveAppCheckout } from "./liveCheckoutInstructions.ts";
import { buildRuntimeInstructions } from "./runtimeInstructions.ts";

const CHECKOUT = "/home/user/t3code-app";

const withCheckout = <A>(checkout: string | undefined, run: () => A): A => {
  setLiveAppCheckout(checkout);
  try {
    return run();
  } finally {
    setLiveAppCheckout(undefined);
  }
};

describe("live app checkout instructions", () => {
  it("are absent until the server sets a checkout", () => {
    const instructions = withCheckout(undefined, () =>
      buildRuntimeInstructions({ harness: "Codex" }),
    );

    assert.notInclude(instructions, "<live_app_checkout>");
    assert.deepStrictEqual(
      withCheckout(undefined, () => liveAppCheckoutCodexContext()),
      {},
    );
  });

  it("name the checkout in every runtime instruction shape", () => {
    for (const pullRequestLinking of [true, false]) {
      const instructions = withCheckout(CHECKOUT, () =>
        buildRuntimeInstructions({ harness: "Claude Code", pullRequestLinking }),
      );

      assert.include(instructions, "<live_app_checkout>");
      assert.include(instructions, `runs in dev mode from the git checkout ${CHECKOUT}.`);
      assert.include(instructions, `git -C '${CHECKOUT}' status`);
      assert.include(instructions, `-- apps/web | git -C '${CHECKOUT}' apply`);
      assert.isTrue(instructions.endsWith("</live_app_checkout>"));
    }
  });

  it("quote a checkout path with spaces and quotes for the shell", () => {
    const instructions = withCheckout("/Users/o'neil/My Apps/t3", () =>
      buildRuntimeInstructions({ harness: "Codex" }),
    );
    assert.include(instructions, `git -C '/Users/o'\\''neil/My Apps/t3' status`);
  });

  it("leave the runtime entry to a caller that sends the text on its own", () => {
    const instructions = withCheckout(CHECKOUT, () =>
      buildRuntimeInstructions({ harness: "Codex", liveAppCheckout: false }),
    );
    const context = withCheckout(CHECKOUT, () => liveAppCheckoutCodexContext());

    assert.notInclude(instructions, "<live_app_checkout>");
    const value = context.t3_code_live_app_checkout?.value ?? "";
    assert.include(value, CHECKOUT);
    // Codex truncates an entry over 4,000 UTF-8 bytes (CODEX_ADDITIONAL_CONTEXT_VALUE_MAX_BYTES).
    assert.isAtMost(Buffer.byteLength(value.replaceAll(CHECKOUT, "/".repeat(200)), "utf8"), 4_000);
  });
});
