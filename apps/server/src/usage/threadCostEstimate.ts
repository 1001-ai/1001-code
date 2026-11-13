import type {
  OrchestrationV2ProviderTurn,
  OrchestrationV2Subagent,
  ThreadCostEstimate,
  TurnTokenUsage,
} from "@t3tools/contracts";
import { EMPTY_TOTALS } from "@t3tools/provider-core/server/usage";

import { withRateModel } from "../provider/Drivers/antigravityUsageReader.ts";
import { lookupRate, type RateTable, type TokenRates } from "./usagePricing.ts";

export interface ThreadCostPricing {
  readonly rates: RateTable;
  readonly overrides: RateTable;
  readonly aliases: ReadonlyMap<string, string>;
}

export type ThreadCostTurn = Pick<
  OrchestrationV2ProviderTurn,
  "status" | "model" | "turnTokenUsage" | "nodeId"
> & {
  /** The driver of the provider thread that ran the turn, which decides how its model is priced. */
  readonly driver: string | null;
};

export interface ThreadCostSource {
  readonly providerTurns: ReadonlyArray<ThreadCostTurn>;
  readonly subagents: ReadonlyArray<
    Pick<OrchestrationV2Subagent, "origin" | "parentNodeId" | "model">
  >;
  /** The thread's selected model, for turns that did not report one. */
  readonly fallbackModel: string | null;
}

// Failed and cancelled turns may have done no model work, so only these count as missing a report.
const REPORTING_TURN_STATUSES = new Set<OrchestrationV2ProviderTurn["status"]>([
  "completed",
  "interrupted",
]);

// Mirrors packages/provider-opencode/src/server/usage.ts: gateways LiteLLM prices under its own prefix.
const OPENCODE_LITELLM_PREFIXES = new Map([["opencode-go", "opencode_go"]]);

/**
 * The names the Usage page prices a turn's model under. OpenCode turns report `provider/model`
 * where its history has the bare model, and Antigravity variants share a base model's price.
 */
function priceNames(
  driver: string | null,
  reported: string,
): { readonly model: string; readonly rateModel: string | undefined } {
  if (driver === "opencode") {
    const slash = reported.indexOf("/");
    if (slash <= 0) return { model: reported, rateModel: undefined };
    const model = reported.slice(slash + 1);
    const prefix = OPENCODE_LITELLM_PREFIXES.get(reported.slice(0, slash));
    return {
      model,
      rateModel: prefix !== undefined && !model.includes("/") ? `${prefix}/${model}` : undefined,
    };
  }
  if (driver === "antigravity") {
    const { rateModel } = withRateModel({
      provider: "antigravity",
      timestampMs: 0,
      model: reported,
      sessionId: "",
      totals: EMPTY_TOTALS,
      reportedCostUsd: null,
      speed: "standard",
      dedupeKey: null,
    });
    return { model: reported, rateModel };
  }
  return { model: reported, rateModel: undefined };
}

// The Usage page's order: an alias replaces the model, then a custom price, the rate model, the model.
function rateFor(
  pricing: ThreadCostPricing,
  driver: string | null,
  reported: string,
): TokenRates | null {
  const names = priceNames(driver, reported);
  const aliased = pricing.aliases.get(names.model);
  const model = aliased ?? names.model;
  const rateModel = aliased === undefined ? names.rateModel : undefined;
  return (
    pricing.overrides.get(model.trim()) ??
    (rateModel === undefined ? null : lookupRate(pricing.rates, rateModel)) ??
    lookupRate(pricing.rates, model)
  );
}

// Claude's native subagents run under the turn's root node; when they share a model, that prices them.
function nativeSubagentModel(
  thread: ThreadCostSource,
  turn: Pick<ThreadCostTurn, "nodeId">,
): string | null {
  const models = new Set<string | null>();
  for (const subagent of thread.subagents) {
    if (subagent.origin === "provider_native" && subagent.parentNodeId === turn.nodeId) {
      models.add(subagent.model);
    }
  }
  const [only] = models;
  return models.size === 1 && only !== undefined ? only : null;
}

// A turn sums many requests, so context tiers (chosen per request) cannot apply; base rates do.
function turnCost(usage: TurnTokenUsage, rates: TokenRates, otherRates: TokenRates): number {
  const cached = usage.cachedInputTokens ?? 0;
  const cacheWrite = usage.cacheCreationTokens ?? 0;
  const input = usage.inputTokens ?? cached + cacheWrite;
  const uncached = Math.max(0, input - cached - cacheWrite);
  const inputCost = (at: TokenRates) =>
    uncached * at.inputCostPerToken +
    cached * at.cacheReadCostPerToken +
    cacheWrite * at.cacheCreationCostPerToken;
  const main = inputCost(rates) + (usage.outputTokens ?? 0) * rates.outputCostPerToken;
  const other = usage.otherUsage;
  if (other === undefined) return main;
  // Ledger extras (native subagents, compaction) arrive unsplit; assume the turn's cache mix.
  const otherInputRate = input > 0 ? inputCost(otherRates) / input : otherRates.inputCostPerToken;
  return (
    main + other.inputTokens * otherInputRate + other.outputTokens * otherRates.outputCostPerToken
  );
}

function hasCounts(usage: TurnTokenUsage | undefined): usage is TurnTokenUsage {
  return (
    usage !== undefined && (usage.inputTokens !== undefined || usage.outputTokens !== undefined)
  );
}

/** Prices a thread and its subagent threads; `threads[0]` is the thread itself. */
export function estimateThreadCost(
  threads: ReadonlyArray<ThreadCostSource>,
  pricing: ThreadCostPricing,
  truncated = false,
): ThreadCostEstimate {
  let costUsd = 0;
  let pricedTurns = 0;
  let unpricedTurns = 0;
  let unreportedTurns = 0;
  for (const thread of threads) {
    for (const turn of thread.providerTurns) {
      const usage = turn.turnTokenUsage;
      if (usage?.localCommand === true) continue;
      if (!hasCounts(usage)) {
        if (REPORTING_TURN_STATUSES.has(turn.status)) unreportedTurns += 1;
        continue;
      }
      const model = turn.model ?? usage.models?.[0] ?? thread.fallbackModel;
      const rates = model === null ? null : rateFor(pricing, turn.driver, model);
      if (rates === null) {
        unpricedTurns += 1;
        continue;
      }
      const subagentModel = usage.otherUsage ? nativeSubagentModel(thread, turn) : null;
      const otherRates =
        (subagentModel === null ? null : rateFor(pricing, turn.driver, subagentModel)) ?? rates;
      costUsd += turnCost(usage, rates, otherRates);
      pricedTurns += 1;
    }
  }
  return {
    costUsd: pricedTurns > 0 ? costUsd : null,
    pricedTurns,
    unpricedTurns,
    unreportedTurns,
    subagentThreads: Math.max(0, threads.length - 1),
    truncated,
  };
}
