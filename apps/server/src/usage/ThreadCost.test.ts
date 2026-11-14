import { describe, expect, it } from "@effect/vitest";
import { NodeId, ProviderThreadId, ThreadId, type TurnTokenUsage } from "@t3tools/contracts";
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
const PROVIDER_THREAD = ProviderThreadId.make("provider-thread");

const turn = (
  turnTokenUsage?: TurnTokenUsage,
  model?: string,
  fields: Partial<ThreadCostTurn> = {},
): ThreadCostTurn => ({
  status: "completed",
  nodeId: ROOT_NODE,
  providerThreadId: PROVIDER_THREAD,
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

  it("prices ledger extras as subagent work at the model their native subagents share", () => {
    // The main agent's mix (all cache writes here) says nothing about its subagents' work.
    const extras = usage({
      inputTokens: MILLION,
      cacheCreationTokens: MILLION,
      outputTokens: 0,
      otherUsage: { inputTokens: MILLION, outputTokens: MILLION },
    });
    const native = (
      model: string | null,
      parentNodeId = ROOT_NODE,
      workflowModels?: ReadonlyArray<string>,
    ): ThreadCostSource["subagents"][number] => ({
      origin: "provider_native",
      parentNodeId,
      model,
      ...(workflowModels === undefined
        ? {}
        : {
            workflow: {
              runHandles: {},
              phases: [],
              agents: workflowModels.map((agentModel, index) => ({
                index,
                label: `agent ${index}`,
                state: "completed",
                model: agentModel,
              })),
            } as unknown as NonNullable<ThreadCostSource["subagents"][number]["workflow"]>,
          }),
    });
    const OTHER_NODE = NodeId.make("other-node");
    const cases: ReadonlyArray<[string, ThreadCostSource["subagents"], number]> = [
      // Main: 1M cache writes = 2.5. Extras at main-model: 0.975*0.2 + 0.025*2.5 + 10.
      ["no subagents", [], 2.5 + 0.2575 + 10],
      // small-model has no cache prices, so 1M input at 1 + 1M output at 5.
      ["one shared model", [native("small-model"), native("small-model")], 2.5 + 1 + 5],
      ["mixed models", [native("small-model"), native("main-model")], 2.5 + 0.2575 + 10],
      ["unknown model", [native(null)], 2.5 + 0.2575 + 10],
      ["a workflow's agents", [native(null, ROOT_NODE, ["small-model", "small-model"])], 8.5],
      [
        "a workflow of mixed agents",
        [native(null, ROOT_NODE, ["small-model", "main-model"])],
        12.7575,
      ],
      // Background subagents started by an earlier turn report in this one.
      ["the thread's when the turn started none", [native("small-model", OTHER_NODE)], 8.5],
      [
        "the turn's own before the thread's",
        [native("small-model", OTHER_NODE), native("main-model")],
        12.7575,
      ],
    ];
    for (const [name, subagents, expected] of cases) {
      const estimate = estimateThreadCost(
        [thread([turn(extras)], "main-model", subagents)],
        pricing(),
      );
      expect(estimate.costUsd, name).toBeCloseTo(expected, 6);
    }
  });

  it("drops a resumed Claude process's restored ledger from its extras", () => {
    const claudeTurn = (fields: Partial<TurnTokenUsage>, extra: Partial<ThreadCostTurn> = {}) =>
      turn(usage({ cachedInputTokens: MILLION, outputTokens: 0, ...fields }), "main-model", {
        driver: "claudeAgent",
        ...extra,
      });
    const cost = (...turns: ReadonlyArray<ThreadCostTurn>) =>
      estimateThreadCost([thread(turns)], pricing()).costUsd;
    // Each turn: 1M cache reads = 0.2. 1M extras input = 0.2575, 1M extras output = 10.
    const cases: ReadonlyArray<[string, ReadonlyArray<ThreadCostTurn>, number]> = [
      [
        "a restore repeats every earlier turn and its extras, then adds new work",
        [
          claudeTurn({ otherUsage: { inputTokens: MILLION, outputTokens: MILLION } }),
          claudeTurn({ otherUsage: { inputTokens: 3 * MILLION, outputTokens: 2 * MILLION } }),
        ],
        0.2 + 0.2575 + 10 + 0.2 + 0.2575 + 10,
      ],
      [
        "a restore with no new work adds nothing",
        [
          claudeTurn({ otherUsage: { inputTokens: 0, outputTokens: 0 } }),
          claudeTurn({ otherUsage: { inputTokens: MILLION, outputTokens: 0 } }),
        ],
        0.4,
      ],
      [
        "extras below the recorded total are new work",
        [
          claudeTurn({ otherUsage: { inputTokens: 0, outputTokens: 0 } }),
          claudeTurn({ otherUsage: { inputTokens: MILLION / 2, outputTokens: MILLION } }),
        ],
        0.4 + 0.2575 / 2 + 10,
      ],
      [
        "each provider thread keeps its own ledger",
        [
          claudeTurn({ otherUsage: { inputTokens: 0, outputTokens: 0 } }),
          claudeTurn(
            { otherUsage: { inputTokens: MILLION, outputTokens: 0 } },
            { providerThreadId: ProviderThreadId.make("other-provider-thread") },
          ),
        ],
        0.4 + 0.2575,
      ],
      [
        // A local command's counters are not model work; its extras (compaction) are.
        "a local command prices its extras and restores count it",
        [
          claudeTurn({
            localCommand: true,
            inputTokens: 0,
            cachedInputTokens: 0,
            otherUsage: { inputTokens: MILLION, outputTokens: 0 },
          }),
          claudeTurn({ otherUsage: { inputTokens: 2 * MILLION, outputTokens: 0 } }),
        ],
        0.2575 + 0.2 + 0.2575,
      ],
    ];
    for (const [name, turns, expected] of cases) {
      expect(cost(...turns), name).toBeCloseTo(expected, 6);
    }
  });

  it("prices the main agent's one-hour cache writes at twice input", () => {
    const writes = usage({ cacheCreationTokens: MILLION, outputTokens: 0 });
    const cost = (promptCacheTtlMs: number | undefined) =>
      estimateThreadCost(
        [
          thread([
            turn(
              writes,
              "main-model",
              promptCacheTtlMs === undefined
                ? {}
                : {
                    tokenUsage: {
                      usedTokens: 0,
                      promptCacheTtlMs,
                      updatedAt: "2026-01-01T00:00:00.000Z",
                    },
                  },
            ),
          ]),
        ],
        pricing(),
      ).costUsd;
    expect(cost(undefined)).toBeCloseTo(2.5, 6);
    expect(cost(5 * 60_000)).toBeCloseTo(2.5, 6);
    expect(cost(60 * 60_000)).toBeCloseTo(4, 6);
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
