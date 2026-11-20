import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { type ReactNode, useLayoutEffect, useRef, useState } from "react";

import { useMediaQuery } from "../../hooks/useMediaQuery";
import { observeResize } from "../../lib/observeResize";
import { cn } from "../../lib/utils";
import { RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY } from "../../rightPanelLayout";
import { selectThreadRightPanelState, useRightPanelStore } from "../../rightPanelStore";
import { useQuietThreadShell } from "../../state/entities";
import { PANE_STRIP_ATTRIBUTE } from "./paneStrip.logic";
import { PaneStripIndicator } from "./PaneStripIndicator";
import { PaneStripMoves } from "./PaneStripMoves";
import { PaneStripContext, usePaneStripSetting } from "./paneStripMode";
import { PaneStripProjectPane } from "./PaneStripProjectPane";
import * as Width from "./PaneStripWidth";

/**
 * With the Labs switch on, lays the open thread out as one column of a sideways-scrolling strip:
 * the project pane (its Inbox and activity feed) to its left, the thread's panes to its right.
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
  const [nudgeHost, setNudgeHost] = useState<HTMLDivElement | null>(null);
  const threadColumnRef = useRef<HTMLDivElement | null>(null);
  const projectId = useQuietThreadShell(threadRef)?.projectId ?? null;
  const panesOpen = useRightPanelStore(
    (state) =>
      !narrow &&
      threadRef !== null &&
      selectThreadRightPanelState(state.byThreadKey, threadRef).isOpen,
  );
  const threadKey = threadRef === null ? null : scopedThreadKey(threadRef);
  const projectPaneShown = !narrow && threadRef !== null && projectId !== null;
  const threadWidth = Width.usePaneStripWidth("thread");
  Width.usePaneStripWidthKeys(scroller);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- rests the DOM scroller on the thread column when a thread opens or the project pane appears beside it
  useLayoutEffect(() => {
    const threadColumn = threadColumnRef.current;
    if (threadKey === null || scroller === null || panesHost === null || threadColumn === null) {
      return;
    }
    // The panes arrive after the thread column, and until they do the strip may be too short to
    // scroll that far, so the rest is retried as they mount until it holds. The project pane
    // widens when its Inbox loads, which moves the thread; that is followed until the reader acts.
    const rest = () => {
      const left = projectPaneShown ? threadColumn.offsetLeft : 0;
      scroller.scrollTo({ left });
      if (Math.abs(scroller.scrollLeft - left) <= 1) panes.disconnect();
    };
    const panes = new MutationObserver(rest);
    const projectPane = threadColumn.previousElementSibling;
    const stopResize = projectPane instanceof HTMLElement ? observeResize(projectPane, rest) : null;
    const stop = () => {
      panes.disconnect();
      stopResize?.();
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
  }, [threadKey, projectPaneShown, scroller, panesHost]);

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1">
      <div
        ref={setScroller}
        {...{ [PANE_STRIP_ATTRIBUTE]: "" }}
        className="relative flex min-h-0 min-w-0 flex-1 snap-x snap-mandatory overflow-x-auto overflow-y-hidden overscroll-x-contain [scrollbar-width:none]"
      >
        {projectPaneShown ? (
          <PaneStripProjectPane
            key={`${threadRef.environmentId}:${projectId}`}
            threadRef={threadRef}
            projectId={projectId}
            nudgeHost={nudgeHost}
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
      <div ref={setNudgeHost} className="contents" />
      <PaneStripIndicator scroller={scroller} />
      <PaneStripMoves scroller={scroller} />
    </div>
  );
}
