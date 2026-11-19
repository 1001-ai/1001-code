import type {
  OrchestrationV2ProviderTurn,
  OrchestrationV2Subagent,
  ProviderThreadId,
  ThreadCostEstimate,
  TurnTokenUsage,
} from "@t3tools/contracts";
import { cursorRateModel } from "@t3tools/provider-cursor/server/accountUsage";
import { piUsageReader } from "@t3tools/provider-pi/server/usage";
import * as DateTime from "effect/DateTime";

import { antigravityRateModel } from "../provider/Drivers/antigravityUsageReader.ts";
import {
  lookupRate,
  type PricedRecord,
  priceUsage,
  type RateTable,
  type TokenRates,
} from "./usagePricing.ts";

export interface ThreadCostPricing {
  readonly rates: RateTable;
  readonly overrides: RateTable;
  readonly aliases: ReadonlyMap<string, string>;
}

export type ThreadCostTurn = Pick<
  OrchestrationV2ProviderTurn,
  "status" | "model" | "turnTokenUsage" | "nodeId" | "providerThreadId" | "tokenUsage" | "startedAt"
> & {
  /** The driver of the provider thread that ran the turn, which decides how its model is priced. */
  readonly driver: string | null;
};

export type BilledRecord = PricedRecord & { readonly timestampMs: number };

export interface ThreadCostSource {
  readonly providerTurns: ReadonlyArray<ThreadCostTurn>;
  readonly subagents: ReadonlyArray<
    Pick<OrchestrationV2Subagent, "origin" | "parentNodeId" | "model" | "workflow">
  >;
  /** The thread's selected model, for turns that did not report one. */
  readonly fallbackModel: string | null;
  /**
   * The provider's own billing history for a provider thread, such as Cursor's usage dashboard.
   * Present whenever that history could be read, even before it holds the thread's records.
   */
  readonly billed?: ReadonlyMap<ProviderThreadId, ReadonlyArray<BilledRecord>>;
}

export interface ThreadCostBilling {
  readonly nowMs: number;
  /** The billing history is being fetched, so what the estimate saw may be stale. */
  readonly refreshing: boolean;
}

// Cursor finalizes records within the hour; an older turn without one is left to its estimate.
const BILLING_SETTLE_MS = 60 * 60_000;

/**
 * Each record goes to the newest of the provider thread's turns that had started by its stamp.
 * Cursor stamps a turn's first record half a second to two seconds after T3 marks the turn
 * started, never before, and a long turn's later records further on.
 */
function billedTurns(
  turns: ReadonlyArray<ThreadCostTurn>,
  records: ReadonlyArray<BilledRecord>,
): ReadonlySet<ThreadCostTurn> {
  const starts = turns
    .flatMap((turn) =>
      turn.startedAt === null ? [] : [{ turn, fromMs: DateTime.toEpochMillis(turn.startedAt) }],
    )
    .toSorted((a, b) => a.fromMs - b.fromMs);
  const covered = new Set<ThreadCostTurn>();
  for (const { timestampMs } of records) {
    const owner = starts.findLast((start) => start.fromMs <= timestampMs);
    if (owner !== undefined) covered.add(owner.turn);
  }
  return covered;
}

// The usage readers' own rate naming (UsageService's providerRateModels).
const PROVIDER_RATE_MODELS = new Map<string, (model: string) => string>([
  ["antigravity", antigravityRateModel],
  ["cursor", cursorRateModel],
  ["pi", piUsageReader.rateModel!],
]);

// UsageAggregator's #mapModel: an alias replaces the model and its rate model; an alias the rate
// table does not list prices under its provider's own naming.
function aliasRateModel(
  pricing: ThreadCostPricing,
  provider: string | null,
  alias: string,
): string | undefined {
  if (lookupRate(pricing.rates, alias) !== null || provider === null) return undefined;
  return PROVIDER_RATE_MODELS.get(provider)?.(alias);
}

// The Usage page's order: an alias replaces the model and its rate model, then priceUsage.
// Billed records are Cursor's account history.
function billedCost(pricing: ThreadCostPricing, record: BilledRecord) {
  const alias = pricing.aliases.get(record.model);
  if (alias === undefined) return priceUsage(pricing.rates, record, pricing.overrides);
  const { rateModel: _rateModel, ...rest } = record;
  const rateModel = aliasRateModel(pricing, "cursor", alias);
  return priceUsage(
    pricing.rates,
    rateModel === undefined ? { ...rest, model: alias } : { ...rest, model: alias, rateModel },
    pricing.overrides,
  );
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
 * where its history has the bare model, and Antigravity and Cursor variants share a base model's
 * price.
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
    const rateModel = antigravityRateModel(reported);
    return { model: reported, rateModel: rateModel === reported ? undefined : rateModel };
  }
  if (driver === "cursor") return { model: reported, rateModel: cursorRateModel(reported) };
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
  const rateModel =
    aliased === undefined ? names.rateModel : aliasRateModel(pricing, driver, aliased);
  return (
    pricing.overrides.get(model.trim()) ??
    (rateModel === undefined ? null : lookupRate(pricing.rates, rateModel)) ??
    lookupRate(pricing.rates, model)
  );
}

// A workflow's own model is its caller's; its agents name the models they ran.
function subagentModels(
  subagent: ThreadCostSource["subagents"][number],
): ReadonlyArray<string | null> {
  const agents = subagent.workflow?.agents ?? [];
  return agents.length > 0 ? agents.map((agent) => agent.model ?? null) : [subagent.model];
}

/**
 * The model that prices a turn's ledger extras: the one its native subagents share. Background
 * subagents finish in later turns, so a turn that started none uses the whole thread's.
 */
function nativeSubagentModel(
  thread: ThreadCostSource,
  turn: Pick<ThreadCostTurn, "nodeId">,
): string | null {
  const native = thread.subagents.filter((subagent) => subagent.origin === "provider_native");
  const started = native.filter((subagent) => subagent.parentNodeId === turn.nodeId);
  const models = new Set((started.length > 0 ? started : native).flatMap(subagentModels));
  const [only] = models;
  return models.size === 1 && only !== undefined ? only : null;
}

type LedgerUsage = NonNullable<TurnTokenUsage["otherUsage"]>;

/**
 * A resumed Claude CLI restores its session's model ledger, so the first result of a new process
 * reports every earlier turn's work again as ledger growth. A turn whose extras reach everything
 * the provider thread recorded before it carries that restored total; only the excess is new.
 */
function withoutRestoredLedger(other: LedgerUsage, before: LedgerUsage): LedgerUsage {
  const restored =
    before.inputTokens > 0 &&
    other.inputTokens >= before.inputTokens &&
    other.outputTokens >= before.outputTokens;
  return restored
    ? {
        inputTokens: other.inputTokens - before.inputTokens,
        outputTokens: other.outputTokens - before.outputTokens,
      }
    : other;
}

// Anthropic bills a one-hour cache write at 2x input, 1.6x the five-minute write rates carry.
const HOUR_CACHE_WRITE_MULTIPLIER = 1.6;
const HOUR_MS = 60 * 60_000;

/**
 * Ledger extras (native subagents, compaction) arrive as one unsplit input count. Measured Claude
 * subagents read nearly all of it from cache and write about 2.5% to five-minute caches; the main
 * agent's own mix says nothing about them, since a session's first turn is mostly cache writes.
 */
const EXTRAS_CACHE_WRITE_SHARE = 0.025;

// A turn sums many requests, so context tiers (chosen per request) cannot apply; base rates do.
function turnCost(
  usage: TurnTokenUsage,
  other: LedgerUsage | undefined,
  rates: TokenRates,
  otherRates: TokenRates,
  hourCacheWrites: boolean,
): number {
  const cached = usage.cachedInputTokens ?? 0;
  const cacheWrite = usage.cacheCreationTokens ?? 0;
  const input = usage.inputTokens ?? cached + cacheWrite;
  const uncached = Math.max(0, input - cached - cacheWrite);
  const writeRate =
    rates.cacheCreationCostPerToken * (hourCacheWrites ? HOUR_CACHE_WRITE_MULTIPLIER : 1);
  // A local command's own counters describe its result, not model work.
  const main =
    usage.localCommand === true
      ? 0
      : uncached * rates.inputCostPerToken +
        cached * rates.cacheReadCostPerToken +
        cacheWrite * writeRate +
        (usage.outputTokens ?? 0) * rates.outputCostPerToken;
  if (other === undefined) return main;
  const otherInputRate =
    (1 - EXTRAS_CACHE_WRITE_SHARE) * otherRates.cacheReadCostPerToken +
    EXTRAS_CACHE_WRITE_SHARE * otherRates.cacheCreationCostPerToken;
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
  billing: ThreadCostBilling | null = null,
): ThreadCostEstimate {
  let costUsd = 0;
  let pricedTurns = 0;
  let pricedRecords = 0;
  let unpricedTurns = 0;
  let unreportedTurns = 0;
  let billingPending = billing?.refreshing === true;
  for (const thread of threads) {
    const recorded = new Map<string, LedgerUsage>();
    const cacheTtlMs = new Map<string, number>();
    const covered = new Set<ThreadCostTurn>();
    for (const [providerThreadId, records] of thread.billed ?? []) {
      for (const record of records) {
        const priced = billedCost(pricing, record);
        if (priced.costSource === "unpriced") unpricedTurns += 1;
        else pricedRecords += 1;
        costUsd += priced.costUsd;
      }
      const turns = thread.providerTurns.filter(
        (turn) => turn.providerThreadId === providerThreadId,
      );
      for (const turn of billedTurns(turns, records)) covered.add(turn);
    }
    for (const turn of thread.providerTurns) {
      if (covered.has(turn)) {
        pricedTurns += 1;
        continue;
      }
      if (
        billing !== null &&
        thread.billed?.has(turn.providerThreadId) === true &&
        REPORTING_TURN_STATUSES.has(turn.status) &&
        turn.startedAt !== null &&
        DateTime.toEpochMillis(turn.startedAt) >= billing.nowMs - BILLING_SETTLE_MS
      ) {
        billingPending = true;
      }
      const usage = turn.turnTokenUsage;
      if (!hasCounts(usage)) {
        if (
          turn.turnTokenUsage?.localCommand !== true &&
          REPORTING_TURN_STATUSES.has(turn.status)
        ) {
          unreportedTurns += 1;
        }
        continue;
      }
      const mainInput = usage.localCommand === true ? 0 : (usage.inputTokens ?? 0);
      const mainOutput = usage.localCommand === true ? 0 : (usage.outputTokens ?? 0);
      const before = recorded.get(turn.providerThreadId) ?? { inputTokens: 0, outputTokens: 0 };
      const other =
        usage.otherUsage === undefined
          ? undefined
          : turn.driver === "claudeAgent"
            ? withoutRestoredLedger(usage.otherUsage, before)
            : usage.otherUsage;
      // The snapshot's TTL is the turn's last main request's; one that wrote nothing keeps the session's.
      const ttlMs = turn.tokenUsage?.promptCacheTtlMs ?? cacheTtlMs.get(turn.providerThreadId);
      if (ttlMs !== undefined) cacheTtlMs.set(turn.providerThreadId, ttlMs);
      recorded.set(turn.providerThreadId, {
        inputTokens: before.inputTokens + mainInput + (other?.inputTokens ?? 0),
        outputTokens: before.outputTokens + mainOutput + (other?.outputTokens ?? 0),
      });
      if (
        usage.localCommand === true &&
        (other?.inputTokens ?? 0) + (other?.outputTokens ?? 0) === 0
      ) {
        continue;
      }
      const model = turn.model ?? usage.models?.[0] ?? thread.fallbackModel;
      const rates = model === null ? null : rateFor(pricing, turn.driver, model);
      if (rates === null) {
        unpricedTurns += 1;
        continue;
      }
      const subagentModel = other ? nativeSubagentModel(thread, turn) : null;
      const otherRates =
        (subagentModel === null ? null : rateFor(pricing, turn.driver, subagentModel)) ?? rates;
      const hourCacheWrites = (ttlMs ?? 0) >= HOUR_MS;
      costUsd += turnCost(usage, other, rates, otherRates, hourCacheWrites);
      pricedTurns += 1;
    }
  }
  return {
    costUsd: pricedTurns > 0 || pricedRecords > 0 ? costUsd : null,
    pricedTurns,
    unpricedTurns,
    unreportedTurns,
    subagentThreads: Math.max(0, threads.length - 1),
    truncated,
    ...(billingPending ? { billingPending } : {}),
  };
}
