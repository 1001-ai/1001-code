/** Per-browser switch for the pane strip, set in Labs. */
export const PANE_STRIP_STORAGE_KEY = "t3code:pane-strip-enabled:v1";

/** The scroller; the history swipe stays off inside it, since sideways swipes move the strip. */
export const PANE_STRIP_ATTRIBUTE = "data-pane-strip";

/**
 * The Inbox thread to show left of the open thread, or null when there is none to show: the
 * project has no Inbox yet, or the open thread is the Inbox itself.
 */
export function paneStripInboxThreadId<ThreadId extends string>(input: {
  readonly routeThreadId: ThreadId | null;
  readonly inboxThreadId: ThreadId | null;
}): ThreadId | null {
  if (input.routeThreadId === null || input.inboxThreadId === null) return null;
  return input.inboxThreadId === input.routeThreadId ? null : input.inboxThreadId;
}

/**
 * Whether a newly active pane should scroll into view. Opening a thread never does: the strip
 * rests on the thread, whichever pane was active when the thread was last open.
 */
export function shouldRevealActivePane(
  previous: { readonly threadKey: string; readonly activeSurfaceId: string | null } | null,
  next: { readonly threadKey: string; readonly activeSurfaceId: string | null },
): boolean {
  if (next.activeSurfaceId === null || previous === null) return false;
  return previous.threadKey === next.threadKey && previous.activeSurfaceId !== next.activeSurfaceId;
}

export interface PaneStripColumn {
  readonly label: string;
  readonly left: number;
  readonly width: number;
}

/** Which columns show at this scroll position; a column that only touches an edge does not. */
export function paneStripColumnsOnScreen(
  columns: ReadonlyArray<PaneStripColumn>,
  scrollLeft: number,
  viewportWidth: number,
): ReadonlyArray<boolean> {
  return columns.map(
    (column) =>
      column.left + column.width > scrollLeft + 1 && column.left < scrollLeft + viewportWidth - 1,
  );
}
