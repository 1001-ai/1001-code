import type { RightPanelSurface } from "../../rightPanelStore";

export const PANE_STRIP_PLACEMENT_STORAGE_KEY = "t3code:pane-strip-placement:v1";

/** "outward": panes in the order they were opened. "fixed": each kind of pane has its own place. */
export type PaneStripPlacement = "outward" | "fixed";

/** Each kind's place for "fixed", from the thread outward; a file sits beside the Files browser. */
const FIXED_PLACE = {
  files: 0,
  file: 1,
  diff: 2,
  terminal: 3,
  preview: 4,
  "pull-request": 5,
  "pull-requests": 6,
  issue: 7,
  device: 8,
  thread: 9,
  "linked-thread": 10,
  board: 11,
  memory: 12,
  "agents-board": 13,
} satisfies Record<RightPanelSurface["kind"], number>;

/**
 * The order the strip draws the panes in. The store's list is never reordered, so the tabbed panel
 * keeps opening order and switching back to "outward" restores it. Several panes of one kind keep
 * their opening order among themselves.
 */
export function orderPaneStripSurfaces<S extends Pick<RightPanelSurface, "kind">>(
  surfaces: ReadonlyArray<S>,
  placement: PaneStripPlacement,
): ReadonlyArray<S> {
  if (placement === "outward") return surfaces;
  return surfaces.toSorted((a, b) => FIXED_PLACE[a.kind] - FIXED_PLACE[b.kind]);
}
