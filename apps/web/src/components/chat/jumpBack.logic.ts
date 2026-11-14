import type { TimelineNavigation } from "./timelineViewport";

/** A row the reader saw at the top of the viewport, and how far it was scrolled into. */
export interface JumpBackRow {
  readonly rowId: string;
  readonly offsetWithinRow: number;
}

/**
 * Where the reader was before a link jumped the timeline. Rows, not a pixel offset, so the
 * place survives row re-measurement and history loading above it. Later rows back up the first
 * when a fold change replaces it. A reader at the end goes back to the end, which may have grown.
 */
export interface JumpBackAnchor {
  readonly atEnd: boolean;
  readonly rows: ReadonlyArray<JumpBackRow>;
}

/**
 * One slot: the place before the most recent jump. "jumping" until the jump first moves the
 * viewport away from it; only then is Back worth showing.
 */
export interface JumpBackState<Visit> {
  readonly visit: Visit;
  readonly anchor: JumpBackAnchor;
  readonly phase: "jumping" | "away";
}

export type JumpBackEvent<Visit> =
  | { readonly type: "jump"; readonly visit: Visit; readonly anchor: JumpBackAnchor }
  | { readonly type: "navigation"; readonly navigation: TimelineNavigation }
  | { readonly type: "sample"; readonly near: boolean }
  | { readonly type: "clear" };

/** The reader's own scrolling, as opposed to a UI command or a click inside the timeline. */
export function isReaderScroll(navigation: TimelineNavigation): boolean {
  switch (navigation.source) {
    case "wheel":
    case "touch":
    case "key":
    case "scroll":
      return true;
    case "pointer":
      return navigation.onScrollbar;
    case "command":
      return false;
  }
}

export function nextJumpBack<Visit>(
  state: JumpBackState<Visit> | null,
  event: JumpBackEvent<Visit>,
): JumpBackState<Visit> | null {
  switch (event.type) {
    case "jump":
      return { visit: event.visit, anchor: event.anchor, phase: "jumping" };
    case "clear":
      return null;
    case "navigation":
      if (state === null) return null;
      // Only Scroll to end commands without letting go of follow.
      if (event.navigation.source === "command" && !event.navigation.releasesFollow) return null;
      // Scrolling before the jump moved anything: the reader took over.
      if (state.phase === "jumping" && isReaderScroll(event.navigation)) return null;
      return state;
    case "sample":
      if (state === null) return null;
      if (state.phase === "jumping") return event.near ? state : { ...state, phase: "away" };
      return event.near ? null : state;
  }
}

export function jumpBackVisible<Visit>(state: JumpBackState<Visit> | null, visit: Visit): boolean {
  return state !== null && state.phase === "away" && state.visit === visit;
}

/** Within a third of the viewport of the anchored spot counts as back there. */
const NEAR_VIEWPORT_FRACTION = 1 / 3;

export function isNearAnchor(
  anchor: JumpBackAnchor,
  current: {
    readonly atEnd: boolean;
    readonly viewportHeight: number;
    /** The row's offsetWithinRow now, or undefined when it is not rendered. */
    readonly offsetWithinRow: (rowId: string) => number | undefined;
  },
): boolean {
  if (anchor.atEnd) return current.atEnd;
  for (const row of anchor.rows) {
    const offset = current.offsetWithinRow(row.rowId);
    if (offset === undefined) continue;
    return (
      Math.abs(offset - row.offsetWithinRow) <= current.viewportHeight * NEAR_VIEWPORT_FRACTION
    );
  }
  return false;
}

export type JumpBackTarget = { readonly kind: "end" } | ({ readonly kind: "row" } & JumpBackRow);

/** Where Back scrolls to: the end, or the first anchored row the list still has. */
export function jumpBackTarget(
  anchor: JumpBackAnchor,
  hasRow: (rowId: string) => boolean,
): JumpBackTarget | null {
  if (anchor.atEnd) return { kind: "end" };
  const row = anchor.rows.find((candidate) => hasRow(candidate.rowId));
  return row ? { kind: "row", ...row } : null;
}

/**
 * The activation key of a navigation that jumps this thread's timeline to a cited message, or
 * null. A key already recorded is not a new jump: revealing a side chat quote navigates twice.
 */
export function citationJumpKey(
  citation: { readonly environmentId: string; readonly threadId: string } | null,
  activation: string,
  thread: { readonly environmentId: string; readonly threadId: string },
  lastKey: string | null,
): string | null {
  if (
    citation === null ||
    citation.environmentId !== thread.environmentId ||
    citation.threadId !== thread.threadId ||
    activation === lastKey
  ) {
    return null;
  }
  return activation;
}
