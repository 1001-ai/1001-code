import type { InteractionUpdate } from "@cursor/sdk";
import type { OrchestrationV2ProviderTurn, TurnTokenUsage } from "@t3tools/contracts";

export type CursorTurnUsage = NonNullable<
  Extract<InteractionUpdate, { readonly type: "turn-ended" }>["usage"]
>;

const count = (value: number | undefined) =>
  value !== undefined && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;

/**
 * Sums the usage each `turn-ended` reported during one run. Cursor counts cache reads and writes
 * apart from input, as its usage dashboard does; the contract's input includes both.
 */
export function cursorTurnTokenUsage(
  usages: ReadonlyArray<CursorTurnUsage>,
  hasSubagents: boolean,
  status: OrchestrationV2ProviderTurn["status"],
): TurnTokenUsage {
  if (usages.length === 0) {
    return { usageScope: "main_agent", usageStatus: "unavailable", hasSubagents };
  }
  let uncached = 0;
  let cachedInputTokens = 0;
  let cacheCreationTokens = 0;
  let outputTokens = 0;
  let reasoning = 0;
  for (const usage of usages) {
    uncached += count(usage.inputTokens);
    cachedInputTokens += count(usage.cacheReadTokens);
    cacheCreationTokens += count(usage.cacheWriteTokens);
    outputTokens += count(usage.outputTokens);
    reasoning += count(usage.reasoningTokens);
  }
  const reasoningTokens = Math.min(reasoning, outputTokens);
  return {
    usageScope: "main_agent",
    usageStatus: status === "completed" ? "complete" : "partial",
    hasSubagents,
    inputTokens: uncached + cachedInputTokens + cacheCreationTokens,
    outputTokens,
    cachedInputTokens,
    cacheCreationTokens,
    ...(reasoningTokens > 0 ? { reasoningTokens } : {}),
  };
}
