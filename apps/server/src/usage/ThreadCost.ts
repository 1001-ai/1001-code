import {
  type OrchestrationV2Subagent,
  type ProviderThreadId,
  type ThreadCostEstimate,
  ThreadCostEstimateError,
  type ThreadCostEstimateInput,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { resolveModelAliases } from "./usageAggregation.ts";
import { createOverrideRateTable } from "./usagePricing.ts";
import {
  type BilledRecord,
  estimateThreadCost,
  type ThreadCostSource,
} from "./threadCostEstimate.ts";
import * as UsageService from "./UsageService.ts";

/** Prices a thread and its subagents' threads from their stored per-turn token reports. */
export class ThreadCost extends Context.Service<
  ThreadCost,
  {
    readonly estimate: (
      input: ThreadCostEstimateInput,
    ) => Effect.Effect<ThreadCostEstimate, ThreadCostEstimateError>;
  }
>()("t3/usage/ThreadCost") {}

// Bounds a runaway workflow; a family this large is far past what the strip can summarize honestly.
export const MAX_FAMILY_THREADS = 500;
const READ_CONCURRENCY = 8;

export interface ThreadCostRecords extends ThreadCostSource {
  readonly subagents: ReadonlyArray<
    Pick<
      OrchestrationV2Subagent,
      "childThreadId" | "origin" | "parentNodeId" | "model" | "workflow"
    >
  >;
  /** Cursor's agent id for each Cursor provider thread, which its usage dashboard logs as the session. */
  readonly cursorAgents?: ReadonlyMap<ProviderThreadId, string>;
}

/** Each Cursor provider thread's dashboard records, so its billed cost replaces the estimate. */
export function withCursorBilling(
  family: ReadonlyArray<ThreadCostRecords>,
  records: ReadonlyArray<BilledRecord & { readonly sessionId: string }>,
): ReadonlyArray<ThreadCostRecords> {
  const bySession = new Map<string, BilledRecord[]>();
  for (const record of records) {
    const list = bySession.get(record.sessionId);
    if (list === undefined) bySession.set(record.sessionId, [record]);
    else list.push(record);
  }
  return family.map((thread) => {
    const billed = new Map<ProviderThreadId, ReadonlyArray<BilledRecord>>();
    for (const [providerThreadId, agentId] of thread.cursorAgents ?? []) {
      const list = bySession.get(agentId);
      if (list !== undefined) billed.set(providerThreadId, list);
    }
    return billed.size === 0 ? thread : { ...thread, billed };
  });
}

/** The thread, then every subagent thread below it, each read once. Unreadable children are skipped. */
export const collectThreadFamily = Effect.fn("ThreadCost.collectThreadFamily")(function* <E>(
  rootThreadId: ThreadId,
  read: (threadId: ThreadId) => Effect.Effect<ThreadCostRecords, E>,
) {
  const family: ThreadCostRecords[] = [yield* read(rootThreadId)];
  const seen = new Set<ThreadId>([rootThreadId]);
  let truncated = false;
  let level: ReadonlyArray<ThreadCostRecords> = family;
  while (level.length > 0) {
    const next: ThreadId[] = [];
    for (const { childThreadId } of level.flatMap((thread) => thread.subagents)) {
      if (childThreadId === null || seen.has(childThreadId)) continue;
      if (seen.size >= MAX_FAMILY_THREADS) {
        truncated = true;
        break;
      }
      seen.add(childThreadId);
      next.push(childThreadId);
    }
    const children = yield* Effect.forEach(next, (threadId) => read(threadId).pipe(Effect.option), {
      concurrency: READ_CONCURRENCY,
    });
    level = children.flatMap((child) => (child._tag === "Some" ? [child.value] : []));
    family.push(...level);
  }
  return { family, truncated };
});

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const usage = yield* UsageService.UsageService;
  const settingsService = yield* ServerSettings.ServerSettingsService;

  const read = (threadId: ThreadId) =>
    threads.getThreadRecords(threadId, ["providerTurns", "subagents", "providerThreads"]).pipe(
      Effect.map(({ thread, providerTurns, subagents, providerThreads }): ThreadCostRecords => {
        const drivers = new Map(providerThreads.map((entry) => [entry.id, entry.driver]));
        const cursorAgents = new Map<ProviderThreadId, string>();
        for (const entry of providerThreads) {
          const agentId = entry.nativeThreadRef?.nativeId;
          if (entry.driver === "cursor" && agentId) cursorAgents.set(entry.id, agentId);
        }
        return {
          providerTurns: providerTurns.map((turn) => ({
            ...turn,
            driver: drivers.get(turn.providerThreadId) ?? null,
          })),
          subagents,
          fallbackModel: thread.modelSelection.model,
          cursorAgents,
        };
      }),
    );

  const estimate = Effect.fn("ThreadCost.estimate")(
    function* (input: ThreadCostEstimateInput) {
      const { family, truncated } = yield* collectThreadFamily(input.threadId, read);
      const hasCursor = family.some((thread) => (thread.cursorAgents?.size ?? 0) > 0);
      const [rates, settings, cursorRecords] = yield* Effect.all(
        [
          usage.readRates,
          settingsService.getSettings.pipe(Effect.option),
          hasCursor ? usage.readAccountRecords("cursor") : Effect.succeed([]),
        ],
        { concurrency: 3 },
      );
      const configured = settings._tag === "Some" ? settings.value : null;
      return estimateThreadCost(
        withCursorBilling(family, cursorRecords),
        {
          rates,
          overrides: createOverrideRateTable(configured?.usagePriceOverrides ?? {}),
          aliases: resolveModelAliases(configured?.usageModelAliases ?? {}),
        },
        truncated,
      );
    },
    (effect, input) =>
      effect.pipe(
        Effect.mapError(
          () =>
            new ThreadCostEstimateError({ detail: `Thread ${input.threadId} could not be read.` }),
        ),
      ),
  );

  return ThreadCost.of({ estimate });
});

export const layer = Layer.effect(ThreadCost, make);
