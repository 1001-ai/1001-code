import type { ProjectId, ProjectMoment, ScopedThreadRef } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { useEffect, useRef, useState, type MouseEvent } from "react";

import { useLocalStorage } from "~/hooks/useLocalStorage";
import { useClientSettings } from "~/hooks/useSettings";
import { observeResize } from "~/lib/observeResize";
import { useOpenPrLink } from "~/lib/openPullRequestLink";
import { cn } from "~/lib/utils";
import { agentsBoardRefresh, useAgentsBoard } from "~/state/agentsBoard";
import { useTeamCatalog } from "~/state/teamCatalog";
import { useAtomCommand } from "~/state/use-atom-command";
import { formatShortTimestamp } from "~/timestampFormat";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import type { MessagesTimelineRow } from "./MessagesTimeline.logic";
import {
  findMessageRow,
  type MomentCard,
  type MomentTone,
  mergeMomentCards,
  resolveMomentCardMaxWidth,
  teammateMomentCards,
  withDaySeparators,
} from "./timelineMoments.logic";

const TEAMMATES_STORAGE_KEY = "t3code:timeline-moments:teammates";
const WINDOW_MILLIS = 7 * 24 * 60 * 60 * 1000;
// The board is fetched on subscribe and refresh only; focus asks again at most this often.
const BOARD_FOCUS_REFRESH_MILLIS = 60_000;

const TONE_BORDER: Record<MomentTone, string> = {
  ask: "border-warning/25",
  prompt: "border-info/25",
  agent: "border-guest/25",
  done: "border-success/25",
  testing: "border-update/25",
  merged: "border-primary/25",
  started: "border-info/25",
};
const TONE_BORDER_STRONG: Record<MomentTone, string> = {
  ask: "border-warning/50",
  prompt: "border-info/50",
  agent: "border-guest/50",
  done: "border-success/50",
  testing: "border-update/50",
  merged: "border-primary/50",
  started: "border-info/50",
};

interface HoveredCard {
  readonly card: MomentCard;
  readonly top: number;
  readonly left: number;
  readonly minWidth: number;
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
  const viewerLogin = useTeamCatalog(environmentId)?.viewer.login ?? null;
  const refreshBoard = useAtomCommand(agentsBoardRefresh);
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const [showTeammates, setShowTeammates] = useLocalStorage(
    TEAMMATES_STORAGE_KEY,
    true,
    Schema.Boolean,
  );
  const navigate = useNavigate();
  const openPullRequest = useOpenPrLink(threadRef);
  const [hovered, setHovered] = useState<HoveredCard | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
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
    teammates: boardReady ? teammateMomentCards(board.board, viewerLogin) : [],
    showTeammates,
    sinceMillis: nowMillis - WINDOW_MILLIS,
  });
  const entries = withDaySeparators(cards, nowMillis);
  const cardMaxWidth = resolveMomentCardMaxWidth(gutterWidth);

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
    setHovered(null);
  };

  const showDetail = (card: MomentCard, element: HTMLElement) => {
    const root = rootRef.current;
    if (!root) return;
    const rootRect = root.getBoundingClientRect();
    const rect = element.getBoundingClientRect();
    setHovered({
      card,
      top: rect.top - rootRect.top,
      left: rect.left - rootRect.left,
      minWidth: rect.width,
    });
  };

  const attachStack = (node: HTMLDivElement | null) => {
    if (!node) return;
    const list = node.firstElementChild;
    const pinToBottom = () => {
      if (atBottomRef.current) node.scrollTop = node.scrollHeight;
    };
    // An empty or short stack leaves the wheel to the chat, as the minimap does.
    const forwardWheel = (event: WheelEvent) => {
      if (node.scrollHeight <= node.clientHeight) onWheel(event);
    };
    const onScroll = () => {
      atBottomRef.current = node.scrollHeight - node.scrollTop - node.clientHeight <= 2;
      setHovered(null);
    };
    node.addEventListener("wheel", forwardWheel, { passive: false });
    node.addEventListener("scroll", onScroll, { passive: true });
    const stopObserving = list instanceof HTMLElement ? observeResize(list, pinToBottom) : null;
    pinToBottom();
    return () => {
      node.removeEventListener("wheel", forwardWheel);
      node.removeEventListener("scroll", onScroll);
      stopObserving?.();
    };
  };

  return (
    <div
      ref={rootRef}
      className="pointer-events-none absolute inset-y-0 left-0 z-40 select-none"
      data-testid="timeline-moment-cards"
      style={{ width: gutterWidth }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setHovered(null);
      }}
    >
      <div
        ref={attachStack}
        className="pointer-events-auto flex h-full flex-col overflow-y-auto overscroll-contain [scrollbar-width:none]"
      >
        <div className="mt-auto flex flex-col gap-1.5 px-3 pt-3 pb-6">
          {teamProject ? (
            <label className="mb-1 flex w-fit items-center gap-2 text-muted-foreground text-xs">
              <Switch
                size="sm"
                checked={showTeammates}
                onCheckedChange={(checked) => setShowTeammates(checked)}
              />
              Teammates
            </label>
          ) : null}
          {entries.map((entry) => {
            if (entry.kind === "day") {
              return (
                <div
                  key={entry.id}
                  className="mt-1 ps-7 text-3xs text-muted-foreground uppercase tracking-wider"
                >
                  {entry.label}
                </div>
              );
            }
            const card = entry.card;
            const row = card.tone === "prompt" || card.tone === "agent" ? rowFor(card) : null;
            return (
              <div key={card.id} className="flex items-center gap-2">
                <span
                  aria-hidden="true"
                  className="h-0.5 w-5 shrink-0 origin-left scale-x-[0.6] rounded-full bg-foreground opacity-55 transition-[transform,opacity] duration-150 motion-reduce:transition-none data-[in-view=true]:scale-x-100 data-[in-view=true]:opacity-100"
                  data-in-view="false"
                  ref={(node) => {
                    if (row === null) return;
                    if (node) stripMap.set(row.rowId, node);
                    else stripMap.delete(row.rowId);
                  }}
                />
                <button
                  type="button"
                  className={cn(
                    "min-w-0 cursor-pointer truncate rounded-lg border bg-card/90 px-2.5 py-1 text-left font-medium text-foreground text-xs leading-5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                    TONE_BORDER[card.tone],
                    card.personal && "ms-3",
                  )}
                  style={{ maxWidth: cardMaxWidth }}
                  onPointerEnter={(event) => showDetail(card, event.currentTarget)}
                  onFocus={(event) => showDetail(card, event.currentTarget)}
                  onClick={(event) => primaryAction(card, event)}
                >
                  {card.label}
                </button>
                <time
                  className="shrink-0 font-mono text-2xs text-muted-foreground"
                  dateTime={card.at}
                >
                  {formatShortTimestamp(card.at, timestampFormat)}
                </time>
              </div>
            );
          })}
        </div>
      </div>
      {hovered ? (
        <MomentCardDetail
          hovered={hovered}
          inThisThread={hovered.card.threadId === threadRef.threadId}
          onLeave={() => setHovered(null)}
          onPrimary={(event) => primaryAction(hovered.card, event)}
          onJump={() => {
            jumpTo(hovered.card);
            setHovered(null);
          }}
          onOpenThread={() => openThread(hovered.card)}
          onOpenPullRequest={(event, url) => openPullRequest(event, url)}
        />
      ) : null}
    </div>
  );
}

function MomentCardDetail({
  hovered,
  inThisThread,
  onLeave,
  onPrimary,
  onJump,
  onOpenThread,
  onOpenPullRequest,
}: {
  hovered: HoveredCard;
  inThisThread: boolean;
  onLeave: () => void;
  onPrimary: (event: MouseEvent<HTMLElement>) => void;
  onJump: () => void;
  onOpenThread: () => void;
  onOpenPullRequest: (event: MouseEvent<HTMLElement>, url: string) => void;
}) {
  const card = hovered.card;
  const source =
    card.threadId === null ? card.threadTitle : inThisThread ? "This thread" : card.threadTitle;
  return (
    // Overlaps the message column like the minimap's preview; it grows in place from the card.
    <div
      className={cn(
        "pointer-events-auto absolute z-50 w-max max-w-80 origin-top-left rounded-xl border bg-popover p-3 text-left text-popover-foreground shadow-xl shadow-black/25 transition-[opacity,scale] duration-150 ease-out starting:scale-95 starting:opacity-0 motion-reduce:transition-none motion-reduce:starting:scale-100 motion-reduce:starting:opacity-100",
        TONE_BORDER_STRONG[card.tone],
      )}
      style={{ top: hovered.top, left: hovered.left, minWidth: hovered.minWidth }}
      onPointerLeave={onLeave}
    >
      <button
        type="button"
        className="block cursor-pointer text-left font-medium text-sm leading-5 focus-visible:outline-none"
        onClick={onPrimary}
      >
        {card.label}
      </button>
      {source ? <div className="mt-0.5 text-muted-foreground text-xs">{source}</div> : null}
      {card.detail ? (
        <p
          className="mt-1.5 overflow-hidden text-foreground/85 text-xs leading-5"
          style={{ display: "-webkit-box", WebkitBoxOrient: "vertical", WebkitLineClamp: 4 }}
        >
          {card.detail}
        </p>
      ) : null}
      <div className="mt-2 flex gap-1.5">
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
