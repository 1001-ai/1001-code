import { describe, expect, it } from "@effect/vitest";
import { ThreadId, type TurnTokenUsage } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { collectThreadFamily, type ThreadCostRecords } from "./ThreadCost.ts";
import { estimateThreadCost, type ThreadCostPricing } from "./threadCostEstimate.ts";
import { createOverrideRateTable, parseRateTable } from "./usagePricing.ts";

const MILLION = 1_000_000;

const pricing = (overrides: ThreadCostPricing["overrides"] = new Map()): ThreadCostPricing => ({
  rates: parseRateTable({
    "main-model": {
      input_cost_per_token: 2 / MILLION,
      output_cost_per_token: 10 / MILLION,
      cache_read_input_token_cost: 0.2 / MILLION,
      cache_creation_input_token_cost: 2.5 / MILLION,
      input_cost_per_token_above_200k_tokens: 4 / MILLION,
    },
    "small-model": { input_cost_per_token: 1 / MILLION, output_cost_per_token: 5 / MILLION },
  }),
  overrides,
  aliases: new Map(),
});

const usage = (fields: Partial<TurnTokenUsage> = {}): TurnTokenUsage =>
  ({
    usageScope: "main_agent",
    usageStatus: "complete",
    hasSubagents: false,
    inputTokens: MILLION,
    outputTokens: MILLION,
    ...fields,
  }) as TurnTokenUsage;

const turn = (turnTokenUsage?: TurnTokenUsage, model?: string) => ({
  status: "completed" as const,
  ...(model === undefined ? {} : { model }),
  ...(turnTokenUsage === undefined ? {} : { turnTokenUsage }),
});

describe("estimateThreadCost", () => {
  it("prices each turn at base rates, splitting cached input, and adds subagent threads", () => {
    const estimate = estimateThreadCost(
      [
        {
          // 1M input of which 600k cache reads and 100k cache writes; tiers do not apply to sums.
          providerTurns: [
            turn(usage({ cachedInputTokens: 600_000, cacheCreationTokens: 100_000 }), "main-model"),
          ],
          fallbackModel: "main-model",
        },
        { providerTurns: [turn(usage())], fallbackModel: "small-model" },
      ],
      pricing(),
    );
    // Root: 0.3*2 + 0.6*0.2 + 0.1*2.5 + 10 = 10.97. Child: 1 + 5 = 6.
    expect(estimate.costUsd).toBeCloseTo(16.97, 6);
    expect(estimate).toMatchObject({ pricedTurns: 2, unpricedTurns: 0, subagentThreads: 1 });
  });

  it("prices ledger extras with the turn's cache mix", () => {
    const estimate = estimateThreadCost(
      [
        {
          providerTurns: [
            turn(
              usage({
                inputTokens: MILLION,
                cachedInputTokens: MILLION,
                outputTokens: 0,
                otherUsage: { inputTokens: MILLION, outputTokens: MILLION },
              }),
            ),
          ],
          fallbackModel: "main-model",
        },
      ],
      pricing(),
    );
    // Main: 1M cache reads = 0.2. Extras: 1M input at the same all-cached mix = 0.2, plus 10 output.
    expect(estimate.costUsd).toBeCloseTo(10.4, 6);
  });

  it("uses custom prices and aliases like the Usage page", () => {
    const aliased = estimateThreadCost(
      [{ providerTurns: [turn(usage(), "preview-model")], fallbackModel: null }],
      { ...pricing(), aliases: new Map([["preview-model", "small-model"]]) },
    );
    expect(aliased.costUsd).toBeCloseTo(6, 6);

    const custom = estimateThreadCost(
      [{ providerTurns: [turn(usage(), "main-model")], fallbackModel: null }],
      pricing(
        createOverrideRateTable({
          "main-model": { inputCostPerMillionTokens: 1, outputCostPerMillionTokens: 1 },
        }),
      ),
    );
    expect(custom.costUsd).toBeCloseTo(2, 6);
  });

  it("never reports $0 for work it could not price", () => {
    const estimate = estimateThreadCost(
      [
        {
          providerTurns: [
            turn(usage(), "unknown-model"),
            turn(undefined),
            { status: "running" },
            turn(usage({ localCommand: true }), "main-model"),
          ],
          fallbackModel: null,
        },
      ],
      pricing(),
    );
    expect(estimate).toEqual({
      costUsd: null,
      pricedTurns: 0,
      unpricedTurns: 1,
      unreportedTurns: 1,
      subagentThreads: 0,
    });
  });
});

describe("collectThreadFamily", () => {
  const records = (...children: Array<string | null>): ThreadCostRecords => ({
    providerTurns: [],
    fallbackModel: null,
    subagents: children.map((child) => ({
      childThreadId: child === null ? null : ThreadId.make(child),
    })),
  });

  it.effect("walks nested subagent threads once and skips unreadable ones", () =>
    Effect.gen(function* () {
      const threads = new Map<string, ThreadCostRecords>([
        ["root", records("a", "b", null, "missing")],
        ["a", records("c", "root")],
        ["b", records("c")],
        ["c", records()],
      ]);
      const read = (threadId: ThreadId) => {
        const found = threads.get(threadId);
        return found === undefined ? Effect.fail("not found" as const) : Effect.succeed(found);
      };
      const family = yield* collectThreadFamily(ThreadId.make("root"), read);
      expect(family).toEqual([
        threads.get("root"),
        threads.get("a"),
        threads.get("b"),
        threads.get("c"),
      ]);
    }),
  );
});
