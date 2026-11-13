import { describe, expect, it } from "@effect/vitest";
import { NodeId, ThreadId, type TurnTokenUsage } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { collectThreadFamily, MAX_FAMILY_THREADS, type ThreadCostRecords } from "./ThreadCost.ts";
import {
  estimateThreadCost,
  type ThreadCostPricing,
  type ThreadCostSource,
  type ThreadCostTurn,
} from "./threadCostEstimate.ts";
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

const ROOT_NODE = NodeId.make("root-node");

const turn = (
  turnTokenUsage?: TurnTokenUsage,
  model?: string,
  fields: Partial<ThreadCostTurn> = {},
): ThreadCostTurn => ({
  status: "completed",
  nodeId: ROOT_NODE,
  driver: null,
  ...(model === undefined ? {} : { model }),
  ...(turnTokenUsage === undefined ? {} : { turnTokenUsage }),
  ...fields,
});

const thread = (
  providerTurns: ReadonlyArray<ThreadCostTurn>,
  fallbackModel: string | null = null,
  subagents: ThreadCostSource["subagents"] = [],
): ThreadCostSource => ({ providerTurns, fallbackModel, subagents });

describe("estimateThreadCost", () => {
  it("prices each turn at base rates, splitting cached input, and adds subagent threads", () => {
    const estimate = estimateThreadCost(
      [
        // 1M input of which 600k cache reads and 100k cache writes; tiers do not apply to sums.
        thread(
          [turn(usage({ cachedInputTokens: 600_000, cacheCreationTokens: 100_000 }), "main-model")],
          "main-model",
        ),
        thread([turn(usage())], "small-model"),
      ],
      pricing(),
    );
    // Root: 0.3*2 + 0.6*0.2 + 0.1*2.5 + 10 = 10.97. Child: 1 + 5 = 6.
    expect(estimate.costUsd).toBeCloseTo(16.97, 6);
    expect(estimate).toMatchObject({ pricedTurns: 2, unpricedTurns: 0, subagentThreads: 1 });
  });

  it("prices ledger extras with the turn's cache mix at its native subagents' model", () => {
    const extras = usage({
      inputTokens: MILLION,
      cachedInputTokens: MILLION,
      outputTokens: 0,
      otherUsage: { inputTokens: MILLION, outputTokens: MILLION },
    });
    const native = (model: string | null, parentNodeId = ROOT_NODE) => ({
      origin: "provider_native" as const,
      parentNodeId,
      model,
    });
    const cost = (subagents: ThreadCostSource["subagents"]) =>
      estimateThreadCost([thread([turn(extras)], "main-model", subagents)], pricing()).costUsd;

    // Main: 1M cache reads = 0.2. Extras at the main model, same all-cached mix: 0.2 + 10.
    expect(cost([])).toBeCloseTo(10.4, 6);
    // Extras at small-model, which has no cache price: 1M input at 1 + 1M output at 5.
    expect(cost([native("small-model"), native("small-model")])).toBeCloseTo(6.2, 6);
    // Mixed, unknown or another node's subagents keep the turn's model.
    expect(cost([native("small-model"), native("main-model")])).toBeCloseTo(10.4, 6);
    expect(cost([native(null)])).toBeCloseTo(10.4, 6);
    expect(cost([native("small-model", NodeId.make("other-node"))])).toBeCloseTo(10.4, 6);
  });

  it("uses custom prices and aliases like the Usage page", () => {
    const aliased = estimateThreadCost([thread([turn(usage(), "preview-model")])], {
      ...pricing(),
      aliases: new Map([["preview-model", "small-model"]]),
    });
    expect(aliased.costUsd).toBeCloseTo(6, 6);

    const custom = estimateThreadCost(
      [thread([turn(usage(), "main-model")])],
      pricing(
        createOverrideRateTable({
          "main-model": { inputCostPerMillionTokens: 1, outputCostPerMillionTokens: 1 },
        }),
      ),
    );
    expect(custom.costUsd).toBeCloseTo(2, 6);
  });

  it("prices OpenCode's provider-qualified models under the names the Usage page uses", () => {
    const rates = parseRateTable({
      "opencode_go/go-model": { input_cost_per_token: 3 / MILLION, output_cost_per_token: 0 },
      "small-model": { input_cost_per_token: 1 / MILLION, output_cost_per_token: 5 / MILLION },
    });
    const cost = (model: string, overrides: ThreadCostPricing["overrides"] = new Map()) =>
      estimateThreadCost([thread([turn(usage(), model, { driver: "opencode" })])], {
        rates,
        overrides,
        aliases: new Map(),
      }).costUsd;

    expect(cost("opencode-go/go-model")).toBeCloseTo(3, 6);
    expect(cost("anthropic/small-model")).toBeCloseTo(6, 6);
    expect(
      cost(
        "opencode-go/go-model",
        createOverrideRateTable({
          "go-model": { inputCostPerMillionTokens: 1, outputCostPerMillionTokens: 1 },
        }),
      ),
    ).toBeCloseTo(2, 6);
  });

  it("never reports $0 for work it could not price", () => {
    const estimate = estimateThreadCost(
      [
        thread([
          turn(usage(), "unknown-model"),
          turn(undefined),
          turn(undefined, undefined, { status: "failed" }),
          turn(undefined, undefined, { status: "running" }),
          turn(usage({ localCommand: true }), "main-model"),
        ]),
      ],
      pricing(),
    );
    expect(estimate).toEqual({
      costUsd: null,
      pricedTurns: 0,
      unpricedTurns: 1,
      unreportedTurns: 1,
      subagentThreads: 0,
      truncated: false,
    });
  });
});

describe("collectThreadFamily", () => {
  const records = (...children: Array<string | null>): ThreadCostRecords => ({
    providerTurns: [],
    fallbackModel: null,
    subagents: children.map((child) => ({
      childThreadId: child === null ? null : ThreadId.make(child),
      origin: "app_owned",
      parentNodeId: ROOT_NODE,
      model: null,
    })),
  });

  const reader = (threads: ReadonlyMap<string, ThreadCostRecords>) => (threadId: ThreadId) => {
    const found = threads.get(threadId);
    return found === undefined ? Effect.fail("not found" as const) : Effect.succeed(found);
  };

  it.effect("walks nested subagent threads once and skips unreadable ones", () =>
    Effect.gen(function* () {
      const threads = new Map<string, ThreadCostRecords>([
        ["root", records("a", "b", null, "missing")],
        ["a", records("c", "root")],
        ["b", records("c")],
        ["c", records()],
      ]);
      const { family, truncated } = yield* collectThreadFamily(
        ThreadId.make("root"),
        reader(threads),
      );
      expect(family).toEqual([
        threads.get("root"),
        threads.get("a"),
        threads.get("b"),
        threads.get("c"),
      ]);
      expect(truncated).toBe(false);
    }),
  );

  it.effect("stops at the family cap, even within one parent, and says so", () =>
    Effect.gen(function* () {
      const children = Array.from({ length: MAX_FAMILY_THREADS + 10 }, (_, index) => `c${index}`);
      const threads = new Map<string, ThreadCostRecords>([
        ["root", records(...children)],
        ...children.map((child): [string, ThreadCostRecords] => [child, records()]),
      ]);
      const { family, truncated } = yield* collectThreadFamily(
        ThreadId.make("root"),
        reader(threads),
      );
      expect(family).toHaveLength(MAX_FAMILY_THREADS);
      expect(truncated).toBe(true);
    }),
  );
});
