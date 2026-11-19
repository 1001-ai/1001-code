import type { PaneStripColumn } from "./paneStrip.logic";

interface StripView {
  readonly scrollLeft: number;
  readonly viewportWidth: number;
  /** The furthest the strip scrolls: its scroll width less its viewport. */
  readonly maxLeft: number;
}

const fullyShown = (column: PaneStripColumn, left: number, viewportWidth: number) =>
  column.left >= left - 1 && column.left + column.width <= left + viewportWidth + 1;

/**
 * Where to scroll so the column shows in full, or null when it already does. The strip snaps to
 * column starts, so this picks the nearest snap position that shows it, not an edge alignment.
 */
export function paneStripRevealLeft(
  columns: ReadonlyArray<PaneStripColumn>,
  target: PaneStripColumn,
  view: StripView,
): number | null {
  if (fullyShown(target, view.scrollLeft, view.viewportWidth)) return null;
  const snaps = [...columns.map((column) => Math.min(column.left, view.maxLeft)), view.maxLeft];
  const showing = snaps.filter((left) => fullyShown(target, left, view.viewportWidth));
  if (showing.length === 0) return Math.min(target.left, view.maxLeft);
  return showing.reduce((best, left) =>
    Math.abs(left - view.scrollLeft) < Math.abs(best - view.scrollLeft) ? left : best,
  );
}

/** Where one wheel notch takes the strip from `fromLeft`: the next column start that way. */
export function paneStripStepLeft(
  columns: ReadonlyArray<PaneStripColumn>,
  fromLeft: number,
  maxLeft: number,
  direction: 1 | -1,
): number | null {
  const snaps = columns.map((column) => Math.min(column.left, maxLeft));
  const next =
    direction === 1
      ? snaps.find((left) => left > fromLeft + 1)
      : snaps.findLast((left) => left < fromLeft - 1);
  return next ?? null;
}

export interface WheelLike {
  readonly shiftKey: boolean;
  readonly deltaX: number;
  readonly deltaY: number;
  readonly deltaMode: number;
  /** The legacy `wheelDelta`: a multiple of 120 for each notch of a mouse wheel. */
  readonly wheelDelta?: number | undefined;
}

/**
 * Which way a shift+wheel event moves the strip by a column, or null to leave it to the browser.
 * Only a mouse wheel's notches step; a trackpad's fine-grained deltas scroll as usual.
 */
export function paneStripWheelDirection(event: WheelLike): 1 | -1 | null {
  if (!event.shiftKey) return null;
  // macOS turns shift+wheel into a sideways delta; other systems keep it vertical.
  const delta = Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
  if (delta === 0) return null;
  const notch =
    event.deltaMode !== 0 ||
    (event.wheelDelta !== undefined && event.wheelDelta !== 0 && event.wheelDelta % 120 === 0);
  if (!notch) return null;
  return delta > 0 ? 1 : -1;
}
