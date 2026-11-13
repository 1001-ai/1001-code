import type {
  OrchestrationV2ProviderTurn,
  ThreadCostEstimate,
  TurnTokenUsage,
} from "@t3tools/contracts";

import { lookupRate, type RateTable, type TokenRates } from "./usagePricing.ts";

export interface ThreadCostPricing {
  readonly rates: RateTable;
  readonly overrides: RateTable;
  readonly aliases: ReadonlyMap<string, string>;
}

export interface ThreadCostSource {
  readonly providerTurns: ReadonlyArray<
    Pick<OrchestrationV2ProviderTurn, "status" | "model" | "turnTokenUsage">
  >;
  /** The thread's selected model, for turns that did not report one. */
  readonly fallbackModel: string | null;
}

const TERMINAL_TURN_STATUSES = new Set<OrchestrationV2ProviderTurn["status"]>([
  "completed",
  "interrupted",
  "failed",
  "cancelled",
]);

// Mirrors the Usage page: an alias prices as its target, and a custom price beats the table.
function rateFor(pricing: ThreadCostPricing, model: string): TokenRates | null {
  const mapped = pricing.aliases.get(model) ?? model;
  return pricing.overrides.get(mapped.trim()) ?? lookupRate(pricing.rates, mapped);
}

// A turn sums many requests, so context tiers (chosen per request) cannot apply; base rates do.
function turnCost(usage: TurnTokenUsage, rates: TokenRates): number {
  const cached = usage.cachedInputTokens ?? 0;
  const cacheWrite = usage.cacheCreationTokens ?? 0;
  const input = usage.inputTokens ?? cached + cacheWrite;
  const uncached = Math.max(0, input - cached - cacheWrite);
  const main =
    uncached * rates.inputCostPerToken +
    cached * rates.cacheReadCostPerToken +
    cacheWrite * rates.cacheCreationCostPerToken +
    (usage.outputTokens ?? 0) * rates.outputCostPerToken;
  const other = usage.otherUsage;
  if (other === undefined) return main;
  // Ledger extras (Claude's native subagents, compaction) arrive unsplit; assume the turn's cache mix.
  const inputCost =
    input > 0
      ? (uncached * rates.inputCostPerToken +
          cached * rates.cacheReadCostPerToken +
          cacheWrite * rates.cacheCreationCostPerToken) /
        input
      : rates.inputCostPerToken;
  return main + other.inputTokens * inputCost + other.outputTokens * rates.outputCostPerToken;
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
        if (TERMINAL_TURN_STATUSES.has(turn.status)) unreportedTurns += 1;
        continue;
      }
      const model = turn.model ?? usage.models?.[0] ?? thread.fallbackModel;
      const rates = model === null ? null : rateFor(pricing, model);
      if (rates === null) {
        unpricedTurns += 1;
        continue;
      }
      costUsd += turnCost(usage, rates);
      pricedTurns += 1;
    }
  }
  return {
    costUsd: pricedTurns > 0 ? costUsd : null,
    pricedTurns,
    unpricedTurns,
    unreportedTurns,
    subagentThreads: Math.max(0, threads.length - 1),
  };
}
