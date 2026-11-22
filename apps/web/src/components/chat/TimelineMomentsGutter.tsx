import type { ScopedThreadRef } from "@t3tools/contracts";
import { use, useState, type ComponentProps, type ReactElement } from "react";

import { observeResize } from "~/lib/observeResize";

import { useQuietThreadShell } from "~/state/entities";
import { useProjectMoments } from "~/state/projectMoments";
import { PaneStripContext } from "../paneStrip/paneStripMode";
import { useActivityListShown } from "./ActivityListToggle";
import type { MessagesTimelineRow } from "./MessagesTimeline.logic";
import type { TimelineMinimap } from "./TimelineMinimap";
import { TimelineMomentCards } from "./TimelineMomentCards";
import { resolveMomentCardsVisible } from "./timelineMoments.logic";

/**
 * The free space left of the message lane. The lane is not always centred (the thread details
 * panel pads the right side), so half the leftover width overstates it.
 */
function resolveMomentGutterWidth(viewportElement: HTMLElement): number {
  const lane = viewportElement.querySelector<HTMLElement>("[data-timeline-root]");
  if (!lane) return 0;
  return Math.max(
    0,
    lane.getBoundingClientRect().left - viewportElement.getBoundingClientRect().left,
  );
}

/** The project's moments as cards when the side gutter fits them; upstream's minimap otherwise. */
export function TimelineMomentsGutter({
  children,
  rows,
  threadRef,
}: {
  /** Upstream's minimap, rendered as it is when the cards do not fit; the cards reuse its props. */
  children: ReactElement<ComponentProps<typeof TimelineMinimap>>;
  rows: ReadonlyArray<MessagesTimelineRow>;
  threadRef: ScopedThreadRef | null;
}) {
  const [gutterWidth, setGutterWidth] = useState(0);
  // A side panel moves the lane by padding the scroller, which resizes neither the viewport nor
  // the lane that upstream's gutter measurement watches; the scroller's content box does change.
  const observeViewport = (anchor: HTMLSpanElement | null) => {
    const viewport = anchor?.closest<HTMLElement>("[data-assistant-citation-viewport]");
    if (!viewport) return;
    const measure = () => setGutterWidth(resolveMomentGutterWidth(viewport));
    const scroller = viewport.querySelector<HTMLElement>(".messages-timeline-scroll");
    const stops = [
      observeResize(viewport, measure),
      scroller ? observeResize(scroller, measure) : null,
    ];
    measure();
    return () => {
      for (const stop of stops) stop?.();
    };
  };
  const inPaneStrip = use(PaneStripContext) !== null;
  const [showCards, setShowCards] = useState(false);
  const nextShowCards = resolveMomentCardsVisible(gutterWidth, showCards);
  if (nextShowCards !== showCards) setShowCards(nextShowCards);

  const projectId = useQuietThreadShell(threadRef)?.projectId ?? null;
  const moments = useProjectMoments(threadRef?.environmentId ?? null, projectId);
  const [activityShown] = useActivityListShown();

  // Until the server answers, and on servers without moments, the minimap keeps the gutter.
  const anchor = <span ref={observeViewport} hidden />;
  // The pane strip shows the timeline as its own column, so the margin keeps the minimap.
  if (inPaneStrip || !nextShowCards || threadRef === null || moments === null) {
    return (
      <>
        {anchor}
        {children}
      </>
    );
  }
  const minimap = children.props;
  return (
    <>
      {anchor}
      {/* With the list hidden, its toggle sits over upstream's minimap. */}
      {activityShown ? null : children}
      {/* Another project's stack starts fresh: its scroll, open card and arrivals are its own. */}
      <TimelineMomentCards
        key={`${threadRef.environmentId}:${projectId}`}
        threadRef={threadRef}
        projectId={projectId}
        moments={moments.moments}
        gutterWidth={gutterWidth}
        rows={rows}
        stripMap={minimap.stripMap}
        onWheel={minimap.onWheel}
        onJump={(rowIndex) =>
          minimap.onSelect({
            id: rows[rowIndex]?.id ?? "",
            rowIndex,
            userText: null,
            assistantText: null,
          })
        }
      />
    </>
  );
}
