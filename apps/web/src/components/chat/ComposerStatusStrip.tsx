import type { ContextWindowSnapshot } from "@t3tools/client-runtime/state/context-window";
import {
  type EnvironmentId,
  isOrchestrationV2WorkActive,
  type ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUsageLimits,
  type ServerProviderUsageWindow,
  type ThreadCostEstimate,
  type ThreadId,
  type UsageLimitSourceSnapshots,
} from "@t3tools/contracts";
import type { ThreadTurnSubagents } from "@t3tools/client-runtime/state/thread-subagents";
import {
  formatDuration,
  type LimitPace,
  paceOf,
  remainingPercent,
} from "@t3tools/shared/usageLimits";
import { memo, useState, type ReactNode } from "react";

import {
  getClientSettings,
  updateClientSettings,
  useClientSettings,
  usePrimarySettings,
} from "../../hooks/useSettings";
import { formatContextWindowTokens } from "../../lib/contextWindow";
import { cn } from "../../lib/utils";
import { useThreadCostEstimate, useThreadTurnSubagents } from "../../state/threadCost";
import { formatUpcomingTimestamp } from "../../timestampFormat";
import { Menu, MenuItem, MenuPopup } from "../ui/menu";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { formatContextWindowCompactionMessage } from "./compaction.logic";
import {
  contextTone,
  formatAge,
  formatCostUsd,
  isLimitsStale,
  limitTone,
  pickLimitWindows,
  resolveInstanceLimits,
  shortWindowLabel,
  type StatusTone,
  subagentLabel,
  subagentTitle,
} from "./composerStatusStrip.logic";
import {
  resolveThreadDetailsVisibility,
  setThreadDetailsItem,
  THREAD_DETAILS_ITEMS,
} from "./threadDetailsItems";

const STATUS_ITEM = THREAD_DETAILS_ITEMS.find((item) => item.id === "composerStatus")!;
const MAX_LISTED_SUBAGENTS = 5;

const PACE_LABEL: Record<LimitPace, string> = {
  ahead: "Ahead of pace",
  on: "On pace",
  under: "Under pace",
};

interface ComposerStatusStripProps {
  readonly environmentId: EnvironmentId;
  /** Null hides the strip, as on a new thread that has nothing to report yet. */
  readonly threadId: ThreadId | null;
  readonly providerInstanceId: ProviderInstanceId | null;
  readonly providers: readonly ServerProvider[];
  readonly sources: UsageLimitSourceSnapshots | undefined;
  readonly contextWindow: ContextWindowSnapshot | null;
}

const EMPTY_SOURCES: UsageLimitSourceSnapshots = [];

const selectVisible = (settings: Parameters<typeof resolveThreadDetailsVisibility>[0]) =>
  resolveThreadDetailsVisibility(settings).composerStatus;

/** One line under the composer: limits, context, running subagents and estimated cost. */
export const ComposerStatusStrip = memo(function ComposerStatusStrip(
  props: ComposerStatusStripProps,
) {
  const visible = useClientSettings(selectVisible);
  const threadId = visible ? props.threadId : null;
  const subagents = useThreadTurnSubagents(props.environmentId, threadId);
  const cost = useThreadCostEstimate(props.environmentId, threadId);
  const [menuPosition, setMenuPosition] = useState<{ x: number; y: number } | null>(null);
  if (threadId === null) return null;

  const limits = resolveInstanceLimits(
    props.providerInstanceId,
    props.providers,
    props.sources ?? EMPTY_SOURCES,
  );
  const windows = limits ? pickLimitWindows(limits.windows) : [];
  const context = props.contextWindow;
  const contextUsed =
    context?.usedPercentage != null && context.maxTokens != null && context.maxTokens > 0
      ? Math.round(Math.max(0, Math.min(100, context.usedPercentage)))
      : null;
  const liveSubagents = subagents?.liveCount ?? 0;
  const costUsd = cost?.costUsd ?? null;
  if (limits === null && context === null && liveSubagents === 0 && costUsd === null) return null;

  return (
    // Out of flow in the spacer under the composer, so its arrival never moves the composer.
    <div
      data-slot="composer-status-strip"
      className="absolute inset-x-0 top-full flex h-4 min-w-0 items-center gap-3 overflow-hidden px-3 text-2xs whitespace-nowrap text-muted-foreground tabular-nums sm:h-5"
      onContextMenu={(event) => {
        event.preventDefault();
        setMenuPosition({ x: event.clientX, y: event.clientY });
      }}
    >
      {limits && windows.length > 0 ? (
        <StatusItem
          label={`Usage limits: ${windows.map((window) => `${window.label} ${remainingPercent(window)}% left`).join(", ")}`}
          tooltip={<LimitsTooltip limits={limits} windows={windows} />}
        >
          {windows.map((window, index) => {
            const left = remainingPercent(window);
            return (
              <span key={window.id} className={cn(toneClass(limitTone(left)))}>
                {index > 0 ? <span className="text-muted-foreground/60"> · </span> : null}
                {shortWindowLabel(window)} {left}%
              </span>
            );
          })}
        </StatusItem>
      ) : null}
      {context ? (
        <StatusItem
          label={`Context window: ${contextUsed !== null ? `${contextUsed}% used` : `${formatContextWindowTokens(context.usedTokens)} tokens used`}`}
          tooltip={<ContextTooltip usage={context} />}
        >
          <span className={cn(toneClass(contextTone(contextUsed)))}>
            ctx{" "}
            {contextUsed !== null
              ? `${contextUsed}%`
              : formatContextWindowTokens(context.usedTokens)}
          </span>
        </StatusItem>
      ) : null}
      {subagents && liveSubagents > 0 ? (
        <StatusItem
          label={`${subagentLabel(liveSubagents)} running`}
          tooltip={<SubagentsTooltip turn={subagents} />}
        >
          {subagentLabel(liveSubagents)}
        </StatusItem>
      ) : null}
      {cost && costUsd !== null ? (
        <StatusItem
          label={`Estimated cost ${formatCostUsd(costUsd)}`}
          tooltip={<CostTooltip estimate={cost} costUsd={costUsd} />}
        >
          {formatCostUsd(costUsd)}
        </StatusItem>
      ) : null}

      <Menu open={menuPosition !== null} onOpenChange={(open) => !open && setMenuPosition(null)}>
        <MenuPopup
          anchor={
            menuPosition
              ? {
                  getBoundingClientRect: () => new DOMRect(menuPosition.x, menuPosition.y, 0, 0),
                }
              : undefined
          }
          align="start"
          side="top"
        >
          <MenuItem onClick={hideStatusLine}>Hide status line</MenuItem>
        </MenuPopup>
      </Menu>
    </div>
  );
}, sameStripProps);

function setStatusLine(visible: boolean) {
  return updateClientSettings({
    threadDetailsItems: setThreadDetailsItem(getClientSettings(), STATUS_ITEM, visible),
  });
}

function hideStatusLine() {
  void setStatusLine(false);
  toastManager.add({
    type: "info",
    title: "Status line hidden",
    description: "Turn it back on in Settings → Appearance → Thread details.",
    actionProps: { children: "Undo", onClick: () => void setStatusLine(true) },
  });
}

// The context snapshot is rebuilt on every parent render; compare what the strip shows.
function sameStripProps(previous: ComposerStatusStripProps, next: ComposerStatusStripProps) {
  const a = previous.contextWindow;
  const b = next.contextWindow;
  return (
    previous.environmentId === next.environmentId &&
    previous.threadId === next.threadId &&
    previous.providerInstanceId === next.providerInstanceId &&
    previous.providers === next.providers &&
    previous.sources === next.sources &&
    (a === b ||
      (a !== null &&
        b !== null &&
        a.usedTokens === b.usedTokens &&
        a.maxTokens === b.maxTokens &&
        a.usedPercentage === b.usedPercentage &&
        a.autoCompactThreshold === b.autoCompactThreshold))
  );
}

function toneClass(tone: StatusTone) {
  return tone === "error"
    ? "text-error-foreground"
    : tone === "warning"
      ? "text-warning-foreground"
      : null;
}

function StatusItem({
  label,
  tooltip,
  children,
}: {
  readonly label: string;
  readonly tooltip: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            tabIndex={0}
            className="min-w-0 shrink-0 cursor-default truncate rounded outline-none last:shrink focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
          />
        }
      >
        <span className="sr-only">{label}</span>
        <span aria-hidden>{children}</span>
      </TooltipTrigger>
      <TooltipPopup side="top">
        <div className="flex flex-col gap-0.5">{tooltip}</div>
      </TooltipPopup>
    </Tooltip>
  );
}

// Tooltip bodies mount when opened, so reading the clock once there keeps the strip timer-free.
function useOpenedAt() {
  const [now] = useState(Date.now);
  return now;
}

function LimitsTooltip({
  limits,
  windows,
}: {
  readonly limits: ServerProviderUsageLimits;
  readonly windows: readonly ServerProviderUsageWindow[];
}) {
  const now = useOpenedAt();
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const age = formatAge(limits.checkedAt, now);
  return (
    <>
      {windows.map((window) => {
        const resetsAt = window.resetsAt ? Date.parse(window.resetsAt) : Number.NaN;
        const pace = paceOf(window, now);
        return (
          <span key={window.id} className="text-foreground">
            {window.label}: {remainingPercent(window)}% left
            <span className="text-muted-foreground">
              {window.resetsAt && resetsAt > now
                ? ` · resets in ${formatDuration(resetsAt - now)} (${formatUpcomingTimestamp(window.resetsAt, timestampFormat, now)})`
                : null}
              {pace ? ` · ${PACE_LABEL[pace]}` : null}
            </span>
          </span>
        );
      })}
      {age ? (
        <span className="text-muted-foreground">
          Checked {age}
          {isLimitsStale(limits.checkedAt, now) ? ", so it may be out of date" : null}
        </span>
      ) : null}
    </>
  );
}

function ContextTooltip({ usage }: { readonly usage: ContextWindowSnapshot }) {
  const threshold = usage.autoCompactThreshold ?? null;
  return (
    <>
      <span className="text-foreground">
        Context:{" "}
        {usage.usedPercentage != null
          ? `${Math.round(usage.usedPercentage)}% used`
          : `${formatContextWindowTokens(usage.usedTokens)} tokens used`}
      </span>
      {usage.maxTokens != null && usage.maxTokens > 0 ? (
        <span className="text-muted-foreground">
          {usage.usedTokens.toLocaleString("en-US")} of {usage.maxTokens.toLocaleString("en-US")}{" "}
          tokens
        </span>
      ) : null}
      {threshold !== null && threshold > 0 ? (
        <span className="text-muted-foreground">
          {formatContextWindowCompactionMessage(threshold)}
        </span>
      ) : null}
    </>
  );
}

function SubagentsTooltip({ turn }: { readonly turn: ThreadTurnSubagents }) {
  const running = turn.subagents.filter((subagent) => isOrchestrationV2WorkActive(subagent.status));
  const hidden = running.length - MAX_LISTED_SUBAGENTS;
  return (
    <>
      <span className="text-foreground">{subagentLabel(running.length)} working</span>
      {running.slice(0, MAX_LISTED_SUBAGENTS).map((subagent) => (
        <span key={subagent.id} className="max-w-64 truncate text-muted-foreground">
          {subagentTitle(subagent)}
        </span>
      ))}
      {hidden > 0 ? <span className="text-muted-foreground">and {hidden} more</span> : null}
    </>
  );
}

function CostTooltip({
  estimate,
  costUsd,
}: {
  readonly estimate: ThreadCostEstimate;
  readonly costUsd: number;
}) {
  const missing = estimate.unpricedTurns + estimate.unreportedTurns;
  return (
    <>
      <span className="text-foreground">Estimated cost: {formatCostUsd(costUsd)}</span>
      <span className="text-muted-foreground">
        At base API prices, not your subscription bill. Long-context and fast-mode surcharges are
        not included.
        {estimate.subagentThreads > 0
          ? ` Includes ${estimate.subagentThreads} subagent ${estimate.subagentThreads === 1 ? "thread" : "threads"}.`
          : null}
      </span>
      {missing > 0 ? (
        <span className="text-muted-foreground">
          {missing} {missing === 1 ? "turn has" : "turns have"} no tokens or price, so the real
          figure may be higher.
        </span>
      ) : null}
      {estimate.truncated ? (
        <span className="text-muted-foreground">
          Some subagent threads were left out, so the real figure may be higher.
        </span>
      ) : null}
    </>
  );
}
