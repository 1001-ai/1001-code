import { ClaudeSettings, ProviderInstanceId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { assert, describe, it } from "vite-plus/test";

import * as ClaudeAdapterV2 from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import {
  BUNDLED_CLAUDE_MODEL_CATALOG,
  getClaudeCatalogModelCapabilities,
} from "./ClaudeModelCatalog.ts";
import { withThreadAutoCompactOption } from "./claudeThreadAutoCompact.ts";

const decodeClaudeSettings = Schema.decodeSync(ClaudeSettings);

const offeredWindows = (model: string) =>
  getClaudeCatalogModelCapabilities(BUNDLED_CLAUDE_MODEL_CATALOG, model).optionDescriptors?.flatMap(
    (descriptor) =>
      descriptor.id === "autoCompactWindow" && descriptor.type === "select"
        ? descriptor.options.map((option) => option.id)
        : [],
  );

describe("per-thread auto-compact window", () => {
  it.each([
    ["claude-opus-4-5", ["default", "100000", "150000"]],
    ["claude-sonnet-4-6", ["default", "100000", "150000", "200000", "300000", "500000"]],
  ])("offers %s only the sizes below its largest window", (model, expected) => {
    assert.deepEqual(offeredWindows(model), expected);
  });

  it("stays off a model with no other list, which the composer would read as reasoning", () => {
    const capabilities = { optionDescriptors: [] };
    assert.strictEqual(withThreadAutoCompactOption(capabilities, {}), capabilities);
  });

  it.each([
    { thread: "150000", instance: "300000", sent: 150_000 },
    { thread: "default", instance: "300000", sent: 300_000 },
    { thread: "150000", instance: "", sent: 150_000 },
    { thread: "999", instance: "300000", sent: 300_000 },
    { thread: "default", instance: "", sent: undefined },
  ])("sends Claude $sent for thread $thread over provider '$instance'", (row) => {
    const options = ClaudeAdapterV2.makeClaudeQueryOptions({
      modelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-sonnet-4-6",
        options: [{ id: "autoCompactWindow", value: row.thread }],
      },
      nativeThreadId: "native-thread-auto-compact",
      resume: false,
      cwd: "/workspace",
      settings: decodeClaudeSettings({ autoCompactWindow: row.instance }),
    });
    const settings = options.settings;
    assert.equal(
      typeof settings === "object" && settings !== null
        ? Reflect.get(settings, "autoCompactWindow")
        : undefined,
      row.sent,
    );
  });
});
