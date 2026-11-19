import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ProjectId, ScopedThreadRef } from "@t3tools/contracts";
import { HistoryIcon } from "lucide-react";
import { type ReactNode, useLayoutEffect, useRef, useState } from "react";

import { isElectron } from "../../env";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { observeResize } from "../../lib/observeResize";
import { cn } from "../../lib/utils";
import { RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY } from "../../rightPanelLayout";
import { selectThreadRightPanelState, useRightPanelStore } from "../../rightPanelStore";
import { useQuietThreadShell } from "../../state/entities";
import { useProjectMoments } from "../../state/projectMoments";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "../../workspaceTitlebar";
import { TimelineMomentCards } from "../chat/TimelineMomentCards";
import { PANE_STRIP_ATTRIBUTE } from "./paneStrip.logic";
import { PaneStripIndicator } from "./PaneStripIndicator";
import { PaneStripContext, usePaneOnScreen, usePaneStripSetting } from "./paneStripMode";
import * as Width from "./PaneStripWidth";

// The cards were written for a chat's margin: these stand in for the open chat's rows and minimap.
const NO_ROWS: [] = [];
const NO_STRIPS = new Map<string, HTMLSpanElement>();
const ignore = () => {};

/**
 * With the Labs switch on, lays the open thread out as one column of a sideways-scrolling strip:
 * the project's timeline to its left, the thread's panes to its right.
 */
export function PaneStripLayout(props: {
  readonly threadRef: ScopedThreadRef | null;
  readonly children: ReactNode;
}) {
  const [enabled] = usePaneStripSetting();
  return enabled ? <PaneStrip {...props} /> : props.children;
}

function PaneStrip(props: {
  readonly threadRef: ScopedThreadRef | null;
  readonly children: ReactNode;
}) {
  const { threadRef } = props;
  // Narrow windows keep the sheet, so the strip is a lone thread there.
  const narrow = useMediaQuery(RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY);
  const [panesHost, setPanesHost] = useState<HTMLDivElement | null>(null);
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const threadColumnRef = useRef<HTMLDivElement | null>(null);
  const projectId = useQuietThreadShell(threadRef)?.projectId ?? null;
  const panesOpen = useRightPanelStore(
    (state) =>
      !narrow &&
      threadRef !== null &&
      selectThreadRightPanelState(state.byThreadKey, threadRef).isOpen,
  );
  const threadKey = threadRef === null ? null : scopedThreadKey(threadRef);
  const timelineShown = !narrow && threadRef !== null && projectId !== null;
  const threadWidth = Width.usePaneStripWidth("thread");
  Width.usePaneStripWidthKeys(scroller);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- rests the DOM scroller on the thread column when a thread opens or the timeline column appears beside it
  useLayoutEffect(() => {
    const threadColumn = threadColumnRef.current;
    if (threadKey === null || scroller === null || panesHost === null || threadColumn === null) {
      return;
    }
    // The panes arrive after the thread column, and until they do the strip may be too short to
    // scroll that far, so the rest is retried as they mount until it holds or the reader moves.
    const rest = () => {
      const left = timelineShown ? threadColumn.offsetLeft : 0;
      scroller.scrollTo({ left });
      if (Math.abs(scroller.scrollLeft - left) <= 1) stop();
    };
    const panes = new MutationObserver(rest);
    const stop = () => {
      panes.disconnect();
      for (const type of ["wheel", "pointerdown", "keydown"] as const) {
        scroller.removeEventListener(type, stop);
      }
    };
    panes.observe(panesHost, { childList: true });
    for (const type of ["wheel", "pointerdown", "keydown"] as const) {
      scroller.addEventListener(type, stop, { passive: true });
    }
    rest();
    return stop;
  }, [threadKey, timelineShown, scroller, panesHost]);

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1">
      <div
        ref={setScroller}
        {...{ [PANE_STRIP_ATTRIBUTE]: "" }}
        className="relative flex min-h-0 min-w-0 flex-1 snap-x snap-mandatory overflow-x-auto overflow-y-hidden overscroll-x-contain [scrollbar-width:none]"
      >
        {timelineShown ? (
          <TimelinePane
            key={`${threadRef.environmentId}:${projectId}`}
            threadRef={threadRef}
            projectId={projectId}
          />
        ) : null}
        <div
          ref={threadColumnRef}
          data-pane-strip-label="Thread"
          {...(panesOpen ? threadWidth.attributes : null)}
          className={cn(
            "flex min-h-0 min-w-0 shrink-0 grow-0 snap-start",
            // Beside panes the thread keeps the width its details card needs to stay open, so
            // on most windows the next pane peeks in at the right edge rather than sharing evenly.
            panesOpen ? threadWidth.className : "basis-full",
            panesOpen && cn("relative", Width.PANE_STRIP_THREAD_CONTROLS_SHIFT_CLASS),
            // The thread's controls are pinned to the window's corner; here they stay with the thread.
            "flex-row [&_[data-workspace-titlebar-controls]]:absolute",
          )}
        >
          <PaneStripContext value={narrow ? null : { panesHost }}>
            {props.children}
          </PaneStripContext>
          {panesOpen ? <Width.PaneStripThreadWidthControl preset={threadWidth.preset} /> : null}
        </div>
        <div ref={setPanesHost} className="contents" />
      </div>
      <PaneStripIndicator scroller={scroller} />
    </div>
  );
}

function TimelinePane(props: {
  readonly threadRef: ScopedThreadRef;
  readonly projectId: ProjectId;
}) {
  const { threadRef, projectId } = props;
  const [observe, onScreen] = usePaneOnScreen();
  // The timeline subscribes the first time its column shows, not while the strip rests beside it.
  const [seen, setSeen] = useState(false);
  if (onScreen && !seen) setSeen(true);

  return (
    <section
      ref={observe}
      data-pane-strip-label="Timeline"
      aria-label="Timeline"
      className="flex min-h-0 min-w-0 shrink-0 grow-0 basis-[min(100%,22rem)] snap-start flex-col border-r border-border bg-background"
    >
      <header
        className={cn(
          "flex h-[var(--workspace-topbar-height)] min-h-[var(--workspace-topbar-height)] shrink-0 items-center gap-2 px-3 text-sm font-medium",
          isElectron && "drag-region",
          COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
        )}
      >
        <HistoryIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        Timeline
      </header>
      {seen ? <TimelineCards threadRef={threadRef} projectId={projectId} /> : null}
    </section>
  );
}

function TimelineCards(props: {
  readonly threadRef: ScopedThreadRef;
  readonly projectId: ProjectId;
}) {
  const moments = useProjectMoments(props.threadRef.environmentId, props.projectId);
  const [width, setWidth] = useState(0);
  const [measure] = useState(() => (node: HTMLDivElement | null) => {
    if (node === null) return undefined;
    setWidth(node.clientWidth);
    return observeResize(node, () => setWidth(node.clientWidth));
  });
  return (
    <div ref={measure} className="relative min-h-0 flex-1">
      {moments !== null && width > 0 ? (
        <TimelineMomentCards
          threadRef={props.threadRef}
          projectId={props.projectId}
          moments={moments.moments}
          gutterWidth={width}
          rows={NO_ROWS}
          stripMap={NO_STRIPS}
          onWheel={ignore}
          onJump={ignore}
        />
      ) : null}
    </div>
  );
}
