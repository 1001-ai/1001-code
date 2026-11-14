import {
  isOrchestrationV2WorkActive,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2Subagent,
  type ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUsageLimits,
  type ServerProviderUsageWindow,
  type UsageLimitSourceSnapshots,
} from "@t3tools/contracts";
import {
  collectProviderUsageLimits,
  limitsNotice,
  remainingPercent,
} from "@t3tools/shared/usageLimits";

export type StatusTone = "error" | "warning" | null;

// Older than this, a limits reading may no longer match the account.
const LIMITS_STALE_AFTER_MS = 15 * 60_000;
const MAX_LIMIT_WINDOWS = 3;
const TIGHT_LIMIT_LEFT_PERCENT = 10;

/** The instance's own limits; another instance on the same login may hold a fresher reading. */
export function resolveInstanceLimits(
  instanceId: ProviderInstanceId | null,
  providers: readonly ServerProvider[],
  sources: UsageLimitSourceSnapshots,
): ServerProviderUsageLimits | null {
  if (instanceId === null) return null;
  // `now` only stamps the report's createdAt, which this ignores.
  const report = collectProviderUsageLimits(instanceId, providers, sources, 0);
  const limits =
    report?.accounts.find((entry) => entry.instanceId === instanceId)?.limits ??
    providers.find((provider) => provider.instanceId === instanceId)?.usageLimits;
  return limits && limitsNotice(limits) === null ? limits : null;
}

const isScoped = (window: ServerProviderUsageWindow) => window.label.includes(" · ");

/** The session and overall weekly windows, then any other window that is nearly spent. */
export function pickLimitWindows(
  windows: readonly ServerProviderUsageWindow[],
): readonly ServerProviderUsageWindow[] {
  const session = windows.find((window) => window.kind === "session");
  const weekly =
    windows.find((window) => window.kind === "weekly" && !isScoped(window)) ??
    windows.find((window) => window.kind === "weekly");
  const primary =
    session || weekly
      ? [session, weekly].filter((window) => window !== undefined)
      : windows.slice(0, 1);
  const tight = windows.filter(
    (window) => !primary.includes(window) && remainingPercent(window) <= TIGHT_LIMIT_LEFT_PERCENT,
  );
  return [...primary, ...tight].slice(0, MAX_LIMIT_WINDOWS);
}

export function shortWindowLabel(window: ServerProviderUsageWindow): string {
  switch (window.kind) {
    case "session": {
      const minutes = window.windowDurationMins;
      return minutes !== undefined && minutes > 0 && minutes % 60 === 0
        ? `${minutes / 60}h`
        : "session";
    }
    case "weekly":
      return isScoped(window) ? `wk ${window.label.split(" · ").slice(1).join(" · ")}` : "wk";
    case "monthly":
      return "mo";
    default:
      return window.label;
  }
}

export function limitTone(leftPercent: number): StatusTone {
  return leftPercent <= 10 ? "error" : leftPercent <= 20 ? "warning" : null;
}

export function contextTone(usedPercent: number | null): StatusTone {
  if (usedPercent === null) return null;
  return usedPercent >= 90 ? "error" : usedPercent >= 80 ? "warning" : null;
}

export function formatAge(fromIso: string, now: number): string | null {
  const at = Date.parse(fromIso);
  if (!Number.isFinite(at)) return null;
  const minutes = Math.max(0, Math.floor((now - at) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}

export function isLimitsStale(checkedAt: string, now: number): boolean {
  const at = Date.parse(checkedAt);
  return !Number.isFinite(at) || now - at > LIMITS_STALE_AFTER_MS;
}

export function formatCostUsd(costUsd: number): string {
  if (costUsd < 0.01) return "<$0.01";
  if (costUsd < 100) return `~$${costUsd.toFixed(2)}`;
  if (costUsd < 10_000) return `~$${Math.round(costUsd).toLocaleString("en-US")}`;
  return `~$${(costUsd / 1_000).toFixed(1)}k`;
}

export function subagentLabel(count: number): string {
  return `${count} ${count === 1 ? "subagent" : "subagents"}`;
}

export function subagentTitle(subagent: Pick<OrchestrationV2Subagent, "title" | "prompt">): string {
  const title = subagent.title?.trim();
  if (title) return title;
  const firstLine = subagent.prompt.trim().split("\n", 1)[0] ?? "";
  return firstLine || "Subagent";
}

/**
 * Changes when a finished turn's token report lands or a subagent settles, the points where the
 * cost can move. Starts and mid-turn reports cannot change a settled figure, so they do not count.
 */
export function threadCostSignal(projection: {
  readonly providerTurns: ReadonlyArray<
    Pick<OrchestrationV2ProviderTurn, "status" | "turnTokenUsage">
  >;
  readonly subagents: ReadonlyArray<Pick<OrchestrationV2Subagent, "status">>;
}): string {
  // Every priced field counts: a finished turn's report can be refined later (cache split, otherUsage, models).
  const reports: string[] = [];
  for (const { status, turnTokenUsage: u } of projection.providerTurns) {
    if (u === undefined || status === "pending" || status === "running") continue;
    reports.push(
      [
        u.usageStatus,
        u.inputTokens,
        u.outputTokens,
        u.cachedInputTokens,
        u.cacheCreationTokens,
        u.reasoningTokens,
        u.otherUsage?.inputTokens,
        u.otherUsage?.outputTokens,
        u.models?.join("+"),
      ].join(","),
    );
  }
  let settled = 0;
  for (const { status } of projection.subagents) {
    if (!isOrchestrationV2WorkActive(status)) settled += 1;
  }
  return `${reports.join(";")}|${settled}`;
}
