import type { RightPanelSurface } from "../../rightPanelStore";

/** The column an open came from: the main chat, a pane, or null for anywhere else. */
export type PaneStripOpener =
  | { readonly kind: "thread" }
  | { readonly kind: "pane"; readonly surfaceId: string }
  | null;

interface Pane {
  readonly id: string;
  readonly kind: RightPanelSurface["kind"];
}

export interface PaneStripReplacement<S extends Pane> {
  readonly opened: S;
  /** Where the opened pane goes in the store's list: directly after its opener. */
  readonly index: number;
  readonly close: ReadonlyArray<S>;
  /** Panes with something running, which the user is asked about before they close. */
  readonly ask: ReadonlyArray<S>;
}

const holdsSession = (surface: Pane) => surface.kind === "terminal" || surface.kind === "preview";

/**
 * What opening one pane from a column replaces: every pane to that column's right. Opening a file
 * swaps the Files browser for it, so an opener that just closed lends the new pane its place.
 * Null when the change is not one new pane (a close, a thread switch, a blank browser or device
 * pane becoming its real one), the opener is unknown, or nothing is to its right.
 */
export function paneStripReplacement<S extends Pane>(input: {
  readonly previous: ReadonlyArray<Pane>;
  readonly surfaces: ReadonlyArray<S>;
  readonly opener: PaneStripOpener;
}): PaneStripReplacement<S> | null {
  const { previous, surfaces, opener } = input;
  if (opener === null) return null;
  const added = surfaces.filter((surface) => !previous.some((entry) => entry.id === surface.id));
  const removed = previous.filter((entry) => !surfaces.some((surface) => surface.id === entry.id));
  const [opened] = added;
  const [swapped] = removed;
  if (opened === undefined || added.length !== 1 || removed.length > 1) return null;
  if (swapped?.kind === opened.kind) return null;
  const others = surfaces.filter((surface) => surface.id !== opened.id);
  const index = ((): number | null => {
    if (opener.kind === "thread") return 0;
    if (opener.surfaceId === opened.id) return null;
    const openerIndex = others.findIndex((entry) => entry.id === opener.surfaceId);
    if (openerIndex >= 0) return openerIndex + 1;
    return swapped?.id === opener.surfaceId ? previous.indexOf(swapped) : null;
  })();
  if (index === null) return null;
  const replaced = others.slice(index);
  if (replaced.length === 0) return null;
  return {
    opened,
    index,
    close: replaced.filter((surface) => !holdsSession(surface)),
    ask: replaced.filter(holdsSession),
  };
}

/** The opener a pointer press or key press names, or `undefined` to leave the last one standing. */
export function paneStripOpenerFromEvent(input: {
  readonly key: string | null;
  readonly modified: boolean;
  /** The pressed column: a pane's surface id, "thread", or null for any other place. */
  readonly column: string | null;
}): PaneStripOpener | undefined {
  // A shortcut opens from nowhere in particular; other typing is not an open at all.
  if (input.key !== null && input.modified) return null;
  if (input.key !== null && input.key !== "Enter" && input.key !== " ") return undefined;
  if (input.column === null) return null;
  return input.column === "thread" ? { kind: "thread" } : { kind: "pane", surfaceId: input.column };
}
