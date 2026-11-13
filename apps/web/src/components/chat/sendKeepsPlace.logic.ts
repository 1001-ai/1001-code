import type { TimelineFollow } from "./timelineViewport";

/** A send leaves the viewport alone once the reader has scrolled away from the live end. */
export function sendKeepsReaderPlace(follow: TimelineFollow): boolean {
  return follow.mode === "released" && !follow.atEnd;
}
