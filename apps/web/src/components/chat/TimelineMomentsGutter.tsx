import type { ScopedThreadRef } from "@t3tools/contracts";
import { useState, type ComponentProps, type ReactElement } from "react";

import { useQuietThreadShell } from "~/state/entities";
import { useProjectMoments } from "~/state/projectMoments";
import type { MessagesTimelineRow } from "./MessagesTimeline.logic";
import type { TimelineMinimap } from "./TimelineMinimap";
import { TimelineMomentCards } from "./TimelineMomentCards";
import { resolveMomentCardsVisible } from "./timelineMoments.logic";

/** The project's moments as cards when the side gutter fits them; upstream's minimap otherwise. */
export function TimelineMomentsGutter({
  children,
  gutterWidth,
  rows,
  threadRef,
}: {
  /** Upstream's minimap, rendered as it is when the cards do not fit; the cards reuse its props. */
  children: ReactElement<ComponentProps<typeof TimelineMinimap>>;
  gutterWidth: number;
  rows: ReadonlyArray<MessagesTimelineRow>;
  threadRef: ScopedThreadRef | null;
}) {
  const [showCards, setShowCards] = useState(false);
  const nextShowCards = resolveMomentCardsVisible(gutterWidth, showCards);
  if (nextShowCards !== showCards) setShowCards(nextShowCards);

  const projectId = useQuietThreadShell(threadRef)?.projectId ?? null;
  const moments = useProjectMoments(threadRef?.environmentId ?? null, projectId);

  // Until the server answers, and on servers without moments, the minimap keeps the gutter.
  if (!nextShowCards || threadRef === null || moments === null) return children;
  const minimap = children.props;
  return (
    <TimelineMomentCards
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
  );
}
