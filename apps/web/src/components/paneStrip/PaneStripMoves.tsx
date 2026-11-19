import { Columns3Icon } from "lucide-react";
import { useEffect, useSyncExternalStore } from "react";

import { registerCommands } from "../../shortcuts/dispatcher";
import { type CommandPaletteActionItem, ITEM_ICON_CLASS } from "../CommandPalette.logic";
import { PANE_STRIP_ATTRIBUTE, type PaneStripColumn } from "./paneStrip.logic";
import {
  paneStripRevealLeft,
  paneStripStepLeft,
  paneStripWheelDirection,
} from "./paneStripMoves.logic";

const LABEL_ATTRIBUTE = "data-pane-strip-label";
const THREAD_LABEL = "Thread";
// Where a column's keyboard focus lands when nothing in it was focused before, as workspace focus.
const PREFERRED_FOCUS =
  '[data-workspace-focus-default], .xterm-helper-textarea, [contenteditable="true"]';
const FOCUSABLE =
  'button:not(:disabled), a[href], input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])';

function readColumns(scroller: HTMLElement): HTMLElement[] {
  return [...scroller.querySelectorAll<HTMLElement>(`[${LABEL_ATTRIBUTE}]`)].filter(
    (column) => column.closest(`[${PANE_STRIP_ATTRIBUTE}]`) === scroller,
  );
}

const measure = (column: HTMLElement): PaneStripColumn => ({
  label: column.dataset.paneStripLabel ?? "",
  left: column.offsetLeft,
  width: column.offsetWidth,
});

const maxLeft = (scroller: HTMLElement) => scroller.scrollWidth - scroller.clientWidth;

const scrollBehavior = (): ScrollBehavior =>
  window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";

/** Scrolls the least far that shows the column whole and still rests on a column start. */
export function revealColumn(scroller: HTMLElement, column: HTMLElement) {
  const left = paneStripRevealLeft(readColumns(scroller).map(measure), measure(column), {
    scrollLeft: scroller.scrollLeft,
    viewportWidth: scroller.clientWidth,
    maxLeft: maxLeft(scroller),
  });
  if (left !== null) scroller.scrollTo({ left, behavior: scrollBehavior() });
}

const lastFocused = new WeakMap<HTMLElement, HTMLElement>();

const isShown = (element: HTMLElement) =>
  element.isConnected &&
  element.closest('[hidden], [inert], [aria-hidden="true"]') === null &&
  element.getClientRects().length > 0;

function focusColumn(column: HTMLElement) {
  const candidates = [
    lastFocused.get(column),
    ...column.querySelectorAll<HTMLElement>(PREFERRED_FOCUS),
    column.matches("[data-workspace-area]")
      ? column
      : column.querySelector<HTMLElement>("[data-workspace-area]"),
    ...column.querySelectorAll<HTMLElement>(FOCUSABLE),
  ];
  for (const candidate of candidates) {
    if (!candidate || !column.contains(candidate) || !isShown(candidate)) continue;
    candidate.focus({ preventScroll: true });
    const active = document.activeElement;
    if (active === candidate || (active !== null && candidate.contains(active))) return;
  }
  // The timeline has no control of its own until its cards load.
  if (!column.hasAttribute("tabindex")) column.tabIndex = -1;
  column.focus({ preventScroll: true });
}

function goToColumn(scroller: HTMLElement, column: HTMLElement) {
  focusColumn(column);
  revealColumn(scroller, column);
}

/** The column focus is in, else the one the strip rests on. */
function currentColumn(scroller: HTMLElement, columns: HTMLElement[]) {
  const focused = document.activeElement?.closest<HTMLElement>(`[${LABEL_ATTRIBUTE}]`);
  if (focused && columns.includes(focused)) return focused;
  return columns.find((column) => column.offsetLeft >= scroller.scrollLeft - 1) ?? columns[0];
}

/** Whether a shift+wheel belongs to a sideways-scrolling element inside the column. */
function innerScrollerTakes(target: EventTarget | null, scroller: HTMLElement, direction: 1 | -1) {
  for (
    let element = target instanceof Element ? target : null;
    element && element !== scroller;
    element = element.parentElement
  ) {
    const { overflowX } = getComputedStyle(element);
    if (overflowX !== "auto" && overflowX !== "scroll") continue;
    const room =
      direction === 1
        ? element.scrollWidth - element.clientWidth - element.scrollLeft
        : element.scrollLeft;
    if (room > 1) return true;
  }
  return false;
}

// The palette lists the open strip's columns; one strip is on screen at a time.
let shownStrip: { readonly scroller: HTMLElement; readonly labels: readonly string[] } | null =
  null;
const stripListeners = new Set<() => void>();
function publishStrip(next: typeof shownStrip) {
  shownStrip = next;
  for (const listener of stripListeners) listener();
}
const subscribeStrip = (listener: () => void) => {
  stripListeners.add(listener);
  return () => stripListeners.delete(listener);
};

/**
 * Keyboard, click and mouse-wheel moves between the strip's columns: the `paneStrip.*` commands
 * focus a neighbour or the thread, a click on a column cut off at an edge brings it in, and each
 * shift+wheel notch moves the strip by one column.
 */
export function PaneStripMoves(props: { readonly scroller: HTMLElement | null }) {
  const { scroller } = props;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- binds keyboard, click and wheel listeners to the strip's DOM scroller
  useEffect(() => {
    if (scroller === null) return;
    const command =
      (
        pick: (columns: HTMLElement[], current: HTMLElement | undefined) => HTMLElement | undefined,
      ) =>
      (event: KeyboardEvent) => {
        if (event.isComposing) return false;
        const columns = readColumns(scroller);
        if (columns.length < 2) return false;
        event.preventDefault();
        event.stopPropagation();
        const target = pick(columns, currentColumn(scroller, columns));
        if (target) goToColumn(scroller, target);
      };
    const step =
      (direction: 1 | -1) => (columns: HTMLElement[], current: HTMLElement | undefined) =>
        current === undefined ? undefined : columns[columns.indexOf(current) + direction];
    const stopCommands = registerCommands(
      {
        "paneStrip.focusLeft": command(step(-1)),
        "paneStrip.focusRight": command(step(1)),
        "paneStrip.focusThread": command((columns) =>
          columns.find((column) => column.dataset.paneStripLabel === THREAD_LABEL),
        ),
      },
      {
        // Capture, so the moves also leave a terminal, which consumes keys itself.
        capture: true,
        when: (event) =>
          !(
            event.target instanceof Element &&
            event.target.closest('[data-keybinding-capture], [role="dialog"], [aria-modal="true"]')
          ),
      },
    );

    const remember = (event: FocusEvent) => {
      const column = (event.target as Element | null)?.closest<HTMLElement>(`[${LABEL_ATTRIBUTE}]`);
      if (column && event.target instanceof HTMLElement && event.target !== column) {
        lastFocused.set(column, event.target);
      }
    };

    const onClick = (event: MouseEvent) => {
      if (event.button !== 0 || !(event.target instanceof Element)) return;
      const column = event.target.closest<HTMLElement>(`[${LABEL_ATTRIBUTE}]`);
      if (column?.isConnected && readColumns(scroller).includes(column)) {
        revealColumn(scroller, column);
      }
    };

    // Quick notches add up: each one steps on from where the last one is heading.
    let heading: number | null = null;
    let settle = 0;
    const arrived = () => {
      heading = null;
      window.clearTimeout(settle);
    };
    const onWheel = (event: WheelEvent) => {
      // macOS moves a shifted notch to the sideways axis, so the per-axis values can miss it.
      const legacy = event as WheelEvent & { wheelDelta?: number };
      const direction = paneStripWheelDirection({
        shiftKey: event.shiftKey,
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        deltaMode: event.deltaMode,
        wheelDelta: legacy.wheelDelta,
      });
      if (direction === null || innerScrollerTakes(event.target, scroller, direction)) return;
      event.preventDefault();
      const left = paneStripStepLeft(
        readColumns(scroller).map(measure),
        heading ?? scroller.scrollLeft,
        maxLeft(scroller),
        direction,
      );
      if (left === null) return;
      heading = left;
      window.clearTimeout(settle);
      // Safari has no scrollend; a smooth scroll is done well within this.
      settle = window.setTimeout(arrived, 700);
      scroller.scrollTo({ left, behavior: scrollBehavior() });
    };

    let labels: readonly string[] = [];
    const publish = () => {
      const next = readColumns(scroller).map((column) => column.dataset.paneStripLabel ?? "");
      if (next.length === labels.length && next.every((label, index) => label === labels[index])) {
        return;
      }
      labels = next;
      publishStrip({ scroller, labels });
    };
    publish();
    const columnsChanged = new MutationObserver(publish);
    columnsChanged.observe(scroller, {
      childList: true,
      subtree: true,
      attributeFilter: [LABEL_ATTRIBUTE],
    });

    scroller.addEventListener("focusin", remember);
    scroller.addEventListener("click", onClick);
    scroller.addEventListener("wheel", onWheel, { passive: false });
    scroller.addEventListener("scrollend", arrived);
    return () => {
      stopCommands();
      columnsChanged.disconnect();
      if (shownStrip?.scroller === scroller) publishStrip(null);
      scroller.removeEventListener("focusin", remember);
      scroller.removeEventListener("click", onClick);
      scroller.removeEventListener("wheel", onWheel);
      scroller.removeEventListener("scrollend", arrived);
      arrived();
    };
  }, [scroller]);

  return null;
}

let paletteTarget: { readonly scroller: HTMLElement; readonly index: number } | null = null;

/** Runs at the palette's focus restoration, after its focus trap lets go of the strip. */
export function restorePaneStripFocusFromPalette(): boolean {
  if (paletteTarget === null) return false;
  const { scroller, index } = paletteTarget;
  paletteTarget = null;
  window.requestAnimationFrame(() => {
    const column = readColumns(scroller)[index];
    if (column) goToColumn(scroller, column);
  });
  return true;
}

/** A palette entry for each column of the strip on screen. */
export function usePaneStripPaletteActions(): CommandPaletteActionItem[] {
  const strip = useSyncExternalStore(subscribeStrip, () => shownStrip);
  if (strip === null || strip.labels.length < 2) return [];
  return strip.labels.map((label, index) => ({
    kind: "action",
    value: `action:pane-strip:${index}:${label}`,
    title: `Go to ${label}`,
    searchTerms: ["pane", "strip", "go to", "focus", label],
    icon: <Columns3Icon className={ITEM_ICON_CLASS} />,
    ...(label === THREAD_LABEL ? { shortcutCommand: "paneStrip.focusThread" as const } : {}),
    run: async () => {
      paletteTarget = { scroller: strip.scroller, index };
    },
  }));
}
