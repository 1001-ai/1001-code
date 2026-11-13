import {
  type OrchestrationV2Subagent,
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
import { estimateThreadCost, type ThreadCostSource } from "./threadCostEstimate.ts";
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
const MAX_FAMILY_THREADS = 500;

export interface ThreadCostRecords extends ThreadCostSource {
  readonly subagents: ReadonlyArray<Pick<OrchestrationV2Subagent, "childThreadId">>;
}

/** The thread, then every subagent thread below it, each read once. Unreadable children are skipped. */
export const collectThreadFamily = Effect.fn("ThreadCost.collectThreadFamily")(function* <E>(
  rootThreadId: ThreadId,
  read: (threadId: ThreadId) => Effect.Effect<ThreadCostRecords, E>,
) {
  const root = yield* read(rootThreadId);
  const family: ThreadCostRecords[] = [root];
  const seen = new Set<ThreadId>([rootThreadId]);
  for (let index = 0; index < family.length && family.length < MAX_FAMILY_THREADS; index += 1) {
    for (const { childThreadId } of family[index]!.subagents) {
      if (childThreadId === null || seen.has(childThreadId)) continue;
      seen.add(childThreadId);
      const child = yield* read(childThreadId).pipe(Effect.option);
      if (child._tag === "Some") family.push(child.value);
    }
  }
  return family;
});

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const usage = yield* UsageService.UsageService;
  const settingsService = yield* ServerSettings.ServerSettingsService;

  const read = (threadId: ThreadId) =>
    threads.getThreadRecords(threadId, ["providerTurns", "subagents"]).pipe(
      Effect.map(({ thread, providerTurns, subagents }): ThreadCostRecords => ({
        providerTurns,
        subagents,
        fallbackModel: thread.modelSelection.model,
      })),
    );

  const estimate = Effect.fn("ThreadCost.estimate")(
    function* (input: ThreadCostEstimateInput) {
      const family = yield* collectThreadFamily(input.threadId, read);
      const [rates, settings] = yield* Effect.all(
        [usage.readRates, settingsService.getSettings.pipe(Effect.option)],
        { concurrency: 2 },
      );
      const configured = settings._tag === "Some" ? settings.value : null;
      return estimateThreadCost(family, {
        rates,
        overrides: createOverrideRateTable(configured?.usagePriceOverrides ?? {}),
        aliases: resolveModelAliases(configured?.usageModelAliases ?? {}),
      });
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
