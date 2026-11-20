import * as Schema from "effect/Schema";
import { createContext, use, useState } from "react";

import { useLocalStorage } from "../../hooks/useLocalStorage";
import { PANE_STRIP_ATTRIBUTE, PANE_STRIP_STORAGE_KEY } from "./paneStrip.logic";

export interface PaneStripHandle {
  /** Where the open thread's ChatView draws its panes, right of the thread column. */
  readonly panesHost: HTMLElement | null;
}

export const PaneStripContext = createContext<PaneStripHandle | null>(null);

export function usePaneStripSetting() {
  return useLocalStorage(PANE_STRIP_STORAGE_KEY, false, Schema.Boolean);
}

/** The strip a ChatView draws its panes into; null for an embedded chat and outside strip mode. */
export function usePaneStrip(embedded: boolean): PaneStripHandle | null {
  const strip = use(PaneStripContext);
  return embedded ? null : strip;
}

/** A ref for a strip column, and whether any of the column is on screen. */
export function usePaneOnScreen(): [
  (node: HTMLElement | null) => (() => void) | undefined,
  boolean,
] {
  const [onScreen, setOnScreen] = useState(false);
  const [observe] = useState(() => (node: HTMLElement | null) => {
    if (node === null) return undefined;
    const observer = new IntersectionObserver(
      (entries) => setOnScreen(entries.at(-1)?.isIntersecting === true),
      // A column resting just off the strip's edge touches it, which counts as intersecting.
      { root: node.closest(`[${PANE_STRIP_ATTRIBUTE}]`), rootMargin: "0px -1px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  });
  return [observe, onScreen];
}

/** Every strip column but a lone thread: half the strip, and never narrower than a readable pane. */
export const PANE_STRIP_COLUMN_CLASS =
  "flex min-h-0 min-w-0 shrink-0 grow-0 basis-[max(50%,min(100%,30rem))] snap-start flex-col";
