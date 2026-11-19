import type { ProjectId, ProjectMoment, ScopedThreadRef } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  BotMessageSquareIcon,
  CheckIcon,
  FlaskConicalIcon,
  type LucideIcon,
  MessageCircleQuestionMarkIcon,
  MessageSquarePlusIcon,
  PlayIcon,
} from "lucide-react";
import * as Schema from "effect/Schema";
import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from "react";

import { useLocalStorage } from "~/hooks/useLocalStorage";
import { useClientSettings } from "~/hooks/useSettings";
import { observeResize } from "~/lib/observeResize";
import { useOpenPrLink } from "~/lib/openPullRequestLink";
import { cn } from "~/lib/utils";
import { agentsBoardRefresh, useAgentsBoard } from "~/state/agentsBoard";
import { useTeamCatalog } from "~/state/teamCatalog";
import { useAtomCommand } from "~/state/use-atom-command";
import { formatShortTimestamp } from "~/timestampFormat";
import { PULL_REQUEST_STATE_PRESENTATION } from "../pullRequest/pullRequestIcons";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import type { MessagesTimelineRow } from "./MessagesTimeline.logic";
import {
  findMessageRow,
  type MomentCard,
  type MomentTone,
  mergeMomentCards,
  momentStackEntries,
  newestMomentArrival,
  resolveMomentCardMaxWidth,
  agentsBoardMomentCards,
} from "./timelineMoments.logic";

const TEAMMATES_STORAGE_KEY = "t3code:timeline-moments:teammates";
const WINDOW_MILLIS = 7 * 24 * 60 * 60 * 1000;
// The board is fetched on subscribe and refresh only; focus asks again at most this often.
const BOARD_FOCUS_REFRESH_MILLIS = 60_000;

const TONE_ICON: Record<MomentTone, { readonly Icon: LucideIcon; readonly color: string }> = {
  ask: { Icon: MessageCircleQuestionMarkIcon, color: "text-warning" },
  prompt: { Icon: MessageSquarePlusIcon, color: "text-info" },
  agent: { Icon: BotMessageSquareIcon, color: "text-guest" },
  done: { Icon: CheckIcon, color: "text-success" },
  testing: { Icon: FlaskConicalIcon, color: "text-update" },
  merged: {
    Icon: PULL_REQUEST_STATE_PRESENTATION.merged.Icon,
    color: PULL_REQUEST_STATE_PRESENTATION.merged.toneClassName,
  },
  started: { Icon: PlayIcon, color: "text-info" },
};

function MomentIcon({ tone, className }: { tone: MomentTone; className?: string }) {
  const { Icon, color } = TONE_ICON[tone];
  return <Icon aria-hidden="true" className={cn("shrink-0", color, className)} />;
}

// The prompt box's glass surface without its backdrop blur: cards stay inside the empty gutter,
// where a blur per card costs a layer each and shows nothing.
const MOMENT_GLASS =
  "border border-border bg-(--moment-glass)/(--glass-opacity) [--moment-glass:var(--card)] dark:[--moment-glass:var(--surface-raised)] [html[data-theme-id]_&]:[--moment-glass:var(--app-theme-surface-raised)]";

// A short pause before a hovered card opens, so a pointer passing over the stack opens nothing.
const OPEN_DELAY_MILLIS = 120;
// On first load the newest cards rise in one after another, this far apart.
const ARRIVAL_STAGGER = { cards: 12, millis: 30 } as const;

/** The card that is open, and the card whose detail stays mounted while it closes. */
interface Expanded {
  readonly open: string | null;
  readonly shown: string | null;
}

export function TimelineMomentCards({
  threadRef,
  projectId,
  moments,
  gutterWidth,
  rows,
  stripMap,
  onWheel,
  onJump,
}: {
  threadRef: ScopedThreadRef;
  projectId: ProjectId | null;
  moments: ReadonlyArray<ProjectMoment>;
  gutterWidth: number;
  rows: ReadonlyArray<MessagesTimelineRow>;
  stripMap: Map<string, HTMLSpanElement>;
  onWheel: (event: WheelEvent) => void;
  onJump: (rowIndex: number) => void;
}) {
  const environmentId = threadRef.environmentId;
  const board = useAgentsBoard(environmentId, projectId);
  const viewer = useTeamCatalog(environmentId)?.viewer ?? null;
  const refreshBoard = useAtomCommand(agentsBoardRefresh);
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const [showTeammates, setShowTeammates] = useLocalStorage(
    TEAMMATES_STORAGE_KEY,
    true,
    Schema.Boolean,
  );
  const navigate = useNavigate();
  const openPullRequest = useOpenPrLink(threadRef);
  const [expanded, setExpanded] = useState<Expanded>({ open: null, shown: null });
  const openTimerRef = useRef<number | null>(null);
  const stackRef = useRef<HTMLDivElement | null>(null);
  const atBottomRef = useRef(true);
  const boardReady = board?.status === "ready";
  const teamProject = board !== null && board.status !== "unavailable";

  const lastBoardRefreshRef = useRef(0);
  // Day labels and the seven-day window move on when someone comes back to the window.
  const [nowMillis, setNowMillis] = useState(() => Date.now());
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- listens for window focus, an outside event, to refresh the clock and the agents board
  useEffect(() => {
    const onFocus = () => {
      const now = Date.now();
      setNowMillis(now);
      if (!teamProject || projectId === null) return;
      if (now - lastBoardRefreshRef.current < BOARD_FOCUS_REFRESH_MILLIS) return;
      lastBoardRefreshRef.current = now;
      void refreshBoard({ environmentId, input: { projectId } });
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [environmentId, projectId, refreshBoard, teamProject]);

  const cards = mergeMomentCards({
    moments,
    board: boardReady ? agentsBoardMomentCards(board.board, viewer) : [],
    showTeammates,
    sinceMillis: nowMillis - WINDOW_MILLIS,
  });
  const entries = momentStackEntries(cards, nowMillis);
  const [arrivalDelays] = useState(
    () =>
      new Map(
        cards
          .slice(-ARRIVAL_STAGGER.cards)
          .map((card, index) => [card.id, index * ARRIVAL_STAGGER.millis]),
      ),
  );

  // Every newer card brings the stack back to the newest, wherever it was scrolled.
  const newestAt = cards.length === 0 ? null : Date.parse(cards[cards.length - 1]!.at);
  const newestSeenRef = useRef<number | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- scrolls the stack, a DOM node, to the card that just arrived before it paints
  useLayoutEffect(() => {
    const arrival = newestMomentArrival(newestSeenRef.current, newestAt);
    newestSeenRef.current = arrival.newestSeen;
    const node = stackRef.current;
    if (!arrival.arrived || node === null) return;
    atBottomRef.current = true;
    node.scrollTop = node.scrollHeight;
  }, [newestAt]);

  const cancelOpen = () => {
    if (openTimerRef.current !== null) window.clearTimeout(openTimerRef.current);
    openTimerRef.current = null;
  };
  const openCard = (id: string) => {
    cancelOpen();
    setExpanded({ open: id, shown: id });
  };
  const openCardSoon = (id: string) => {
    cancelOpen();
    openTimerRef.current = window.setTimeout(() => openCard(id), OPEN_DELAY_MILLIS);
  };
  const closeCard = (id: string) => {
    cancelOpen();
    setExpanded((current) => (current.open === id ? { ...current, open: null } : current));
  };

  const rowFor = (card: MomentCard) =>
    card.threadId === threadRef.threadId && card.messageId !== null
      ? findMessageRow(rows, card.messageId)
      : null;

  const jumpTo = (card: MomentCard) => {
    if (card.messageId === null) {
      onJump(Math.max(0, rows.length - 1));
      return;
    }
    // A message outside the loaded history: the top is as close as the loaded rows get.
    onJump(rowFor(card)?.rowIndex ?? 0);
  };
  const openThread = (card: MomentCard) => {
    if (card.threadId === null) return;
    void navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId, threadId: card.threadId },
    });
  };
  const primaryAction = (card: MomentCard, event: MouseEvent<HTMLElement>) => {
    if (card.threadId === threadRef.threadId) jumpTo(card);
    else if (card.threadId !== null) openThread(card);
    else if (card.pullRequestUrl !== null) openPullRequest(event, card.pullRequestUrl);
  };

  const attachStack = (node: HTMLDivElement | null) => {
    if (!node) return;
    stackRef.current = node;
    const list = node.firstElementChild;
    const pinToBottom = () => {
      if (atBottomRef.current) node.scrollTop = node.scrollHeight;
    };
    // An empty or short stack leaves the wheel to the chat, as the minimap does.
    const forwardWheel = (event: WheelEvent) => {
      if (node.scrollHeight <= node.clientHeight) onWheel(event);
    };
    // Only a move up leaves the bottom: while a card opens, the list grows between this pin and
    // the next, so a scroll event can read "not at the bottom" just after a pin.
    let lastTop = node.scrollTop;
    const onScroll = () => {
      const top = node.scrollTop;
      if (node.scrollHeight - top - node.clientHeight <= 2) atBottomRef.current = true;
      else if (top < lastTop) atBottomRef.current = false;
      lastTop = top;
    };
    node.addEventListener("wheel", forwardWheel, { passive: false });
    node.addEventListener("scroll", onScroll, { passive: true });
    // A card opening or arriving grows the list; a window or panel resize shrinks the stack.
    const stops = [
      list instanceof HTMLElement ? observeResize(list, pinToBottom) : null,
      observeResize(node, pinToBottom),
    ];
    pinToBottom();
    return () => {
      node.removeEventListener("wheel", forwardWheel);
      node.removeEventListener("scroll", onScroll);
      for (const stop of stops) stop?.();
      stackRef.current = null;
    };
  };

  return (
    <div
      className="pointer-events-none absolute inset-y-0 left-0 z-40 flex select-none flex-col"
      data-testid="timeline-moment-cards"
      style={{ width: gutterWidth }}
    >
      {teamProject ? (
        <label className="pointer-events-auto flex w-fit items-center gap-2 px-3 pt-3 pb-1.5 text-muted-foreground text-xs">
          <Switch
            size="sm"
            checked={showTeammates}
            onCheckedChange={(checked) => setShowTeammates(checked)}
          />
          Teammates
        </label>
      ) : null}
      <div className="relative min-h-0 flex-1">
        <div
          ref={attachStack}
          className="pointer-events-auto flex h-full flex-col overflow-y-auto overscroll-contain [scrollbar-width:none]"
        >
          <div className="mt-auto flex flex-col px-3 pt-24 pb-6">
            {entries.map((entry, index) => {
              const first = index === 0;
              if (entry.kind === "day") {
                return (
                  <div
                    key={entry.id}
                    className={cn(
                      "ps-18 text-3xs text-muted-foreground uppercase tracking-wider",
                      !first && "mt-3",
                    )}
                  >
                    {entry.label}
                  </div>
                );
              }
              const card = entry.card;
              const row = card.tone === "prompt" || card.tone === "agent" ? rowFor(card) : null;
              const afterDay = entries[index - 1]?.kind === "day";
              const isOpen = expanded.open === card.id;
              const cardWidth = resolveMomentCardMaxWidth(gutterWidth, card.personal);
              return (
                <div
                  key={card.id}
                  className={cn(
                    "transition-[opacity,translate] duration-200 ease-out starting:translate-y-2 starting:opacity-0 motion-reduce:transition-none motion-reduce:starting:translate-y-0 motion-reduce:starting:opacity-100",
                    first || afterDay ? "mt-1.5" : entry.groupName !== null ? "mt-4" : "mt-1",
                  )}
                  style={{ transitionDelay: `${arrivalDelays.get(card.id) ?? 0}ms` }}
                >
                  {entry.groupName !== null ? (
                    <div
                      className={cn(
                        "mb-1 truncate text-2xs text-muted-foreground",
                        card.personal ? "ps-21" : "ps-18",
                      )}
                    >
                      {entry.groupName}
                    </div>
                  ) : null}
                  <div className="flex items-start gap-2">
                    <span
                      className="w-16 shrink-0 truncate text-2xs text-muted-foreground leading-7.5 tabular-nums transition-colors duration-150 motion-reduce:transition-none data-[in-view=true]:text-foreground"
                      data-in-view="false"
                      ref={(node) => {
                        if (row === null) return;
                        if (node) stripMap.set(row.rowId, node);
                        else stripMap.delete(row.rowId);
                      }}
                    >
                      <time dateTime={card.at}>
                        {formatShortTimestamp(card.at, timestampFormat)}
                      </time>
                    </span>
                    <div
                      className={cn(
                        "min-w-0 overflow-hidden rounded-lg transition-[width] duration-200 ease-out [interpolate-size:allow-keywords] motion-reduce:transition-none",
                        MOMENT_GLASS,
                        card.personal && "ms-3",
                      )}
                      style={{
                        maxWidth: cardWidth,
                        width: isOpen ? cardWidth : "fit-content",
                      }}
                      onPointerEnter={() => openCardSoon(card.id)}
                      onPointerLeave={() => closeCard(card.id)}
                      onFocus={() => openCard(card.id)}
                      onBlur={(event) => {
                        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                          closeCard(card.id);
                        }
                      }}
                    >
                      <button
                        type="button"
                        aria-expanded={isOpen}
                        className="flex w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-lg px-2 py-1 text-left font-medium text-foreground text-xs leading-5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                        onClick={(event) => primaryAction(card, event)}
                      >
                        <MomentIcon tone={card.tone} className="size-3.5" />
                        <span className="truncate">{card.label}</span>
                      </button>
                      {/* w-0 with min-w-full: a closed card's detail never widens the card. */}
                      <div
                        inert={!isOpen}
                        className={cn(
                          "grid w-0 min-w-full transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none",
                          isOpen ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
                        )}
                      >
                        <div className="min-h-0 overflow-hidden">
                          {expanded.shown === card.id ? (
                            <MomentCardDetail
                              card={card}
                              inThisThread={card.threadId === threadRef.threadId}
                              onJump={() => jumpTo(card)}
                              onOpenThread={() => openThread(card)}
                              onOpenPullRequest={(event, url) => openPullRequest(event, url)}
                            />
                          ) : null}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
        {/* Older cards fade into the page; a gradient over the stack costs nothing per frame. */}
        <div className="pointer-events-none absolute inset-x-0 top-0 h-24 bg-gradient-to-b from-background to-transparent" />
      </div>
    </div>
  );
}

function MomentCardDetail({
  card,
  inThisThread,
  onJump,
  onOpenThread,
  onOpenPullRequest,
}: {
  card: MomentCard;
  inThisThread: boolean;
  onJump: () => void;
  onOpenThread: () => void;
  onOpenPullRequest: (event: MouseEvent<HTMLElement>, url: string) => void;
}) {
  const source =
    card.threadId === null ? card.threadTitle : inThisThread ? "This thread" : card.threadTitle;
  return (
    <div className="px-2 pb-2 text-left">
      {source ? <div className="truncate text-muted-foreground text-xs">{source}</div> : null}
      {card.detail ? (
        <p
          className="mt-1 overflow-hidden text-foreground/85 text-xs leading-5"
          style={{ display: "-webkit-box", WebkitBoxOrient: "vertical", WebkitLineClamp: 4 }}
        >
          {card.detail}
        </p>
      ) : null}
      <div className="mt-2 flex flex-wrap gap-1.5">
        {card.pullRequestUrl !== null ? (
          <Button
            size="xs"
            variant="outline"
            onClick={(event) => onOpenPullRequest(event, card.pullRequestUrl!)}
          >
            Open PR
          </Button>
        ) : null}
        {inThisThread ? (
          <Button size="xs" variant="outline" onClick={onJump}>
            Jump to it
          </Button>
        ) : card.threadId !== null ? (
          <Button size="xs" variant="outline" onClick={onOpenThread}>
            Open thread
          </Button>
        ) : null}
      </div>
    </div>
  );
}
