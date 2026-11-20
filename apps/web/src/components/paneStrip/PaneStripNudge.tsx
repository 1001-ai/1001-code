import { useAtomValue } from "@effect/atom-react";
import { parseScopedThreadKey, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { HistoryIcon, InboxIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

import { useProjectMoments } from "../../state/projectMoments";
import { environmentThreadShells } from "../../state/threads";
import { PANE_STRIP_ATTRIBUTE } from "./paneStrip.logic";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { revealColumn } from "./PaneStripMoves";
import {
  addPaneStripArrivals,
  INITIAL_PANE_STRIP_NUDGE_WATCH,
  type PaneStripInboxLatest,
  type PaneStripNudgeShown,
  watchPaneStripArrivals,
} from "./paneStripNudge.logic";

/** Marks the project pane's column, so the nudge can bring it on screen. */
export const PANE_STRIP_PROJECT_ATTRIBUTE = "data-pane-strip-project";

// The Inbox thread's latest message from the raw shell, which the client's shell model leaves
// out. It keeps its value while the agent writes, so streaming ticks do not re-render the nudge.
const inboxLatestAtom = Atom.family((key: string) => {
  let previous: PaneStripInboxLatest | null = null;
  return Atom.make((get): PaneStripInboxLatest | null => {
    const ref = parseScopedThreadKey(key);
    const shell =
      ref === null
        ? undefined
        : get(environmentThreadShells.environmentThreadIndexAtom(ref.environmentId)).get(
            ref.threadId,
          );
    if (shell === undefined) return (previous = null);
    const running = shell.activeRunId !== null;
    const message = shell.latestVisibleMessage;
    if (
      previous !== null &&
      previous.running === running &&
      previous.latestMessage?.id === message?.id &&
      (running || previous.latestMessage?.text === message?.text)
    ) {
      return previous;
    }
    previous = {
      threadId: shell.id,
      running,
      latestMessage:
        message === null ? null : { id: message.id, role: message.role, text: message.text },
    };
    return previous;
  }).pipe(Atom.withLabel(`pane-strip-inbox-latest:${key}`));
});
const NO_INBOX_ATOM = Atom.make<PaneStripInboxLatest | null>(null);

// How long the nudge shows in full before it shrinks to a mark at the edge.
const NUDGE_FULL_MS = 8000;

const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// One-off entrances, run once when the element mounts: transform and opacity only.
const bumpIn = (node: HTMLElement | null) => {
  if (node === null || reducedMotion()) return;
  node.animate(
    [
      { transform: "translateX(-100%)", opacity: 0 },
      { transform: "translateX(0)", opacity: 1 },
    ],
    { duration: 260, easing: "cubic-bezier(0.3, 1.35, 0.5, 1)" },
  );
};
const fadeIn = (node: HTMLElement | null) => {
  if (node === null || reducedMotion()) return;
  node.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, easing: "ease-out" });
};

/**
 * A nudge at the strip's left edge when a new activity card or Inbox reply arrives while the
 * project pane is off screen. It reads the moments subscription the thread's timeline already
 * holds and the Inbox thread's shell, so the pane's chat and cards stay unmounted.
 */
export function PaneStripNudge(props: {
  /** Beside the strip's scroller, so the nudge stays at the edge as the strip scrolls. */
  readonly host: HTMLElement | null;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly openThreadId: ThreadId;
  readonly inboxThreadId: ThreadId | null;
  readonly paneOnScreen: boolean;
}) {
  const { host, environmentId, projectId, openThreadId, inboxThreadId, paneOnScreen } = props;
  const moments = useProjectMoments(environmentId, projectId);
  const inbox = useAtomValue(
    inboxThreadId === null
      ? NO_INBOX_ATOM
      : inboxLatestAtom(scopedThreadKey({ environmentId, threadId: inboxThreadId })),
  );

  const [watch, setWatch] = useState(INITIAL_PANE_STRIP_NUDGE_WATCH);
  const [shown, setShown] = useState<PaneStripNudgeShown | null>(null);
  const [full, setFull] = useState(true);
  const step = watchPaneStripArrivals(watch, {
    moments: moments?.moments ?? null,
    inbox,
    openThreadId,
    paneOnScreen,
  });
  if (step.watch !== watch) {
    setWatch(step.watch);
    if (step.arrivals.length > 0) {
      setShown(addPaneStripArrivals(shown, step.arrivals));
      setFull(true);
    }
  }
  if (paneOnScreen && shown !== null) setShown(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a timer: the full nudge shrinks to its mark a while after the latest arrival
  useEffect(() => {
    if (shown === null || !full) return;
    const timer = window.setTimeout(() => setFull(false), NUDGE_FULL_MS);
    return () => window.clearTimeout(timer);
  }, [shown, full]);

  if (host === null || shown === null) return null;

  const open = () => {
    setShown(null);
    const scroller = host.parentElement?.querySelector<HTMLElement>(`[${PANE_STRIP_ATTRIBUTE}]`);
    const column = scroller?.querySelector<HTMLElement>(`[${PANE_STRIP_PROJECT_ATTRIBUTE}]`);
    if (scroller && column) revealColumn(scroller, column);
  };
  const { latest, count } = shown;
  const Icon = latest.kind === "inbox" ? InboxIcon : HistoryIcon;
  const more = count > 1 ? `${count} new` : null;

  return createPortal(
    // Below the header, so the sidebar toggle and the thread's controls stay clear.
    <div
      aria-live="polite"
      className="pointer-events-none absolute top-[calc(var(--workspace-topbar-height)+0.75rem)] left-0 z-20"
    >
      {full ? (
        <button
          key="full"
          ref={bumpIn}
          type="button"
          onClick={open}
          className="pointer-events-auto flex max-w-80 cursor-pointer items-center gap-2 rounded-r-full border border-l-0 border-border bg-popover py-1.5 pr-3 pl-2.5 text-left text-xs text-popover-foreground shadow-md outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        >
          <Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate">
            <span className="font-medium">{latest.label}</span>
            {latest.detail === "" ? null : (
              <span className="text-muted-foreground"> · {latest.detail}</span>
            )}
          </span>
          {more === null ? null : (
            <span className="shrink-0 rounded-full bg-primary px-1.5 text-3xs leading-4 font-medium text-primary-foreground">
              {more}
            </span>
          )}
        </button>
      ) : (
        <span key="mark" ref={fadeIn} className="pointer-events-auto block">
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-label={`${more ?? latest.label}: show the project pane`}
                  onClick={open}
                  className="group flex h-10 w-3 cursor-pointer items-center rounded-r-sm outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                >
                  <span className="h-7 w-1 rounded-r-full bg-primary group-hover:w-1.5" />
                </button>
              }
            />
            <TooltipPopup side="right">{more ?? latest.label}</TooltipPopup>
          </Tooltip>
        </span>
      )}
    </div>,
    host,
  );
}
