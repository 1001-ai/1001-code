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

/** A glass box under the composer: limits, context, running subagents and estimated cost. */
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
  if (windows.length === 0 && context === null && liveSubagents === 0 && costUsd === null) {
    return null;
  }

  const showSubagents = subagents !== null && liveSubagents > 0;
  return (
    // Its glass is laid over the composer's lower wrapper, so the context row above shares the box.
    <div
      data-slot="composer-status-box"
      // Marks an attached surface, so the composer card paints its own glass as it does for a banner.
      data-composer-banner-surface="attached"
      className={BOX_CLASS}
      onContextMenu={(event) => {
        event.preventDefault();
        setMenuPosition({ x: event.clientX, y: event.clientY });
      }}
    >
      {/* Fixed height and wrapping: items that do not fit drop to a clipped second line, last first. */}
      <div className="pointer-events-auto flex h-7 min-w-0 flex-wrap content-start items-center gap-x-4 overflow-hidden px-2 text-xs whitespace-nowrap tabular-nums @max-[29rem]/status:gap-x-3">
        {limits
          ? windows.map((window, index) => {
              const left = remainingPercent(window);
              const tone = limitTone(left);
              return (
                <StatusItem
                  key={window.id}
                  label={`${window.label} limit: ${left}% left`}
                  tooltip={<LimitsTooltip limits={limits} windows={windows} />}
                  // Narrow boxes keep the first window and context; a window near its limit stays.
                  className={index > 0 && tone === null ? "@max-[29rem]/status:hidden" : undefined}
                >
                  <StatusMeter
                    label={shortWindowLabel(window)}
                    fill={left}
                    tone={tone}
                    value={`${left}% left`}
                  />
                </StatusItem>
              );
            })
          : null}
        {context ? (
          <StatusItem
            label={`Context window: ${contextUsed !== null ? `${contextUsed}% used` : `${formatContextWindowTokens(context.usedTokens)} tokens used`}`}
            tooltip={<ContextTooltip usage={context} />}
          >
            <StatusMeter
              label="Context"
              fill={contextUsed}
              tone={contextTone(contextUsed)}
              value={
                contextUsed !== null
                  ? `${contextUsed}% used`
                  : `${formatContextWindowTokens(context.usedTokens)} used`
              }
            />
          </StatusItem>
        ) : null}
        {showSubagents ? (
          <StatusItem
            label={`${subagentLabel(liveSubagents)} running`}
            tooltip={<SubagentsTooltip turn={subagents} />}
            className="ms-auto"
          >
            <StatusMeter
              label="Subagents"
              fill={null}
              tone={null}
              value={`${liveSubagents} running`}
            />
          </StatusItem>
        ) : null}
        {cost && costUsd !== null ? (
          <StatusItem
            label={`Estimated cost ${formatCostUsd(costUsd)}`}
            tooltip={<CostTooltip estimate={cost} costUsd={costUsd} />}
            className={showSubagents ? undefined : "ms-auto"}
          >
            <StatusMeter label="Cost" fill={null} tone={null} value={formatCostUsd(costUsd)} />
          </StatusItem>
        ) : null}
      </div>

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

// Mirrors ComposerBanner's attached surface, flipped to hang from the composer's bottom edge. The
// glass is a pseudo-element positioned against the wrapper this sits in (the context row's), with
// its top 1rem tucked under the card and masked out so the card's own glass is not doubled.
const BOX_CLASS = cn(
  "@container/status px-(--chat-composer-drawer-inset) pb-1.5",
  "before:pointer-events-none before:absolute before:inset-x-(--chat-composer-drawer-inset) before:-top-[calc(1rem+1px)] before:bottom-0 before:-z-1",
  "before:rounded-b-2xl before:border before:border-(--chat-composer-outline) before:mask-b-from-transparent before:mask-b-from-4 before:mask-b-to-black before:mask-b-to-4",
  "before:bg-(--chat-composer-glass-surface)/(--glass-opacity) before:backdrop-blur-(--glass-blur) before:backdrop-saturate-(--glass-saturation)",
  "before:shadow-composer dark:before:shadow-composer-dark",
  "dark:supports-[(backdrop-filter:blur(1px))_or_(-webkit-backdrop-filter:blur(1px))]:before:bg-composer-seam-below",
  "not-supports-[((backdrop-filter:blur(1px))_or_(-webkit-backdrop-filter:blur(1px)))]:before:bg-(--chat-composer-glass-surface)",
);

/** A label, a small bar and a value, coloured only near a limit. Matches the thread details rows. */
function StatusMeter({
  label,
  fill,
  tone,
  value,
}: {
  readonly label: string;
  /** Bar fill from 0 to 100. Null hides the bar. */
  readonly fill: number | null;
  readonly tone: StatusTone;
  readonly value: string;
}) {
  return (
    <>
      <span className="text-muted-foreground">{label}</span>
      {fill !== null ? (
        <span className="relative h-[3px] w-8 shrink-0 rounded-full bg-muted-foreground/30 dark:bg-muted-foreground/20">
          {fill > 0 ? (
            <span
              className={cn(
                "absolute inset-y-0 left-0 rounded-full",
                tone === "error"
                  ? "bg-error"
                  : tone === "warning"
                    ? "bg-warning"
                    : "bg-muted-foreground",
              )}
              style={{ width: `max(${fill}%, 3px)` }}
            />
          ) : null}
        </span>
      ) : null}
      <span
        className={cn(
          "font-medium",
          tone === "error"
            ? "text-error-foreground"
            : tone === "warning"
              ? "text-warning-foreground"
              : "text-foreground/80",
        )}
      >
        {value}
      </span>
    </>
  );
}

function StatusItem({
  label,
  tooltip,
  className,
  children,
}: {
  readonly label: string;
  readonly tooltip: ReactNode;
  readonly className?: string | undefined;
  readonly children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            tabIndex={0}
            className={cn(
              "flex h-7 shrink-0 cursor-default items-center gap-1.5 rounded outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
              className,
            )}
          />
        }
      >
        <span className="sr-only">{label}</span>
        <span aria-hidden className="contents">
          {children}
        </span>
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

export function SubagentsTooltip({ turn }: { readonly turn: ThreadTurnSubagents }) {
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

export function CostTooltip({
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
