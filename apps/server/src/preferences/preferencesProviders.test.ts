import { ProviderInstanceId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as ClaudeAdapterV2 from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import * as CodexAdapterV2 from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { CODEX_ADDITIONAL_CONTEXT_VALUE_MAX_BYTES } from "../provider/CodexDeveloperInstructions.ts";
import { codexPreferencesContext } from "./preferencesProviders.ts";

const BLOCK = "<preferences>\n- Prefer small pull requests.\n</preferences>";
const bytes = (text: string) => new TextEncoder().encode(text).length;

it("splits the block into Codex entries under the per-entry cap, in order", () => {
  expect(codexPreferencesContext(undefined)).toEqual({});
  const lines = Array.from({ length: 300 }, (_, index) => `- Preference ${index} ✓`);
  const long = ["<preferences>", ...lines, "x".repeat(5_000), "</preferences>"].join("\n");
  const entries = codexPreferencesContext(long);
  const keys = Object.keys(entries);
  expect(keys[0]).toBe("t3_preferences_01");
  expect(keys).toEqual([...keys].toSorted());
  for (const entry of Object.values(entries)) {
    expect(entry.kind).toBe("application");
    expect(bytes(entry.value)).toBeLessThanOrEqual(CODEX_ADDITIONAL_CONTEXT_VALUE_MAX_BYTES);
  }
  // Only the line breaks between entries are dropped.
  const joined = Object.values(entries)
    .map((entry) => entry.value)
    .join("");
  expect(joined.replaceAll("\n", "")).toBe(long.replaceAll("\n", ""));
});

it.effect(
  "Codex gets the block as application context on every turn, with or without T3 tools",
  () =>
    Effect.gen(function* () {
      const params = (hasT3Mcp: boolean) =>
        CodexAdapterV2.buildCodexTurnStartParams({
          nativeThreadId: "native-preferences",
          codexInput: [{ type: "text", text: "hello" }],
          runtimePolicy: { runtimeMode: "full-access", interactionMode: "default", cwd: null },
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
          hasT3Mcp,
          preferences: BLOCK,
        });
      const withoutTools = (yield* params(false)).additionalContext ?? {};
      expect(withoutTools.t3_preferences_01).toEqual({ kind: "application", value: BLOCK });
      expect(withoutTools.t3_code_runtime).toBeUndefined();
      const withTools = (yield* params(true)).additionalContext ?? {};
      expect(withTools.t3_preferences_01).toEqual({ kind: "application", value: BLOCK });
      expect(withTools.t3_code_runtime).toBeDefined();
    }),
);

it("Claude gets the block at the end of its appended system prompt", () => {
  const options = ClaudeAdapterV2.makeClaudeQueryOptions({
    modelSelection: {
      instanceId: ProviderInstanceId.make("claudeAgent"),
      model: "claude-opus-5-5",
    },
    nativeThreadId: "native-preferences",
    resume: false,
    cwd: "/workspace",
    environment: {},
    preferences: BLOCK,
  });
  const append = (options.systemPrompt as { readonly append?: string }).append ?? "";
  expect(append.endsWith(`\n\n${BLOCK}`)).toBe(true);
});
