import { isMacPlatform } from "@t3tools/shared/keybindings";
import * as Schema from "effect/Schema";
import { type MouseEvent, useEffect } from "react";
import { flushSync } from "react-dom";

import { useLocalStorage, writeLocalStorageValue } from "../../hooks/useLocalStorage";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { PANE_STRIP_ATTRIBUTE } from "./paneStrip.logic";
import {
  PANE_STRIP_WIDTH_ATTRIBUTE,
  PANE_STRIP_WIDTH_LABELS,
  PANE_STRIP_WIDTHS_STORAGE_KEY,
  type PaneStripWidthKey,
  type PaneStripWidthPreset,
  paneStripWidthKeyDirection,
  paneStripWidthPreset,
  stepPaneStripWidth,
  withPaneStripWidth,
} from "./paneStripWidth.logic";

const StoredWidths = Schema.Record(Schema.String, Schema.String);
const NO_WIDTHS: Record<string, string> = {};

// Fractions of the strip, so every preset rests on a column edge. The floors keep a narrow
// preset readable on a small strip; "fit" is 64rem because the thread's details card shows
// inline only from about 1016px of chat width.
const WIDTH_CLASS: Record<PaneStripWidthPreset, string> = {
  fit: "basis-[min(100%,max(50%,64rem))]",
  third: "basis-[max(33.3333%,min(100%,20rem))]",
  half: "basis-[max(50%,min(100%,30rem))]",
  "two-thirds": "basis-[66.6667%]",
  full: "basis-full",
};

/** Makes room left of the thread's own header controls for its width control. */
export const PANE_STRIP_THREAD_CONTROLS_SHIFT_CLASS =
  "[&_[data-workspace-titlebar-controls]]:mr-[2.75rem]";

/** The column's chosen width: its basis class, and the attribute its width control finds it by. */
export function usePaneStripWidth(key: PaneStripWidthKey) {
  const [stored] = useLocalStorage(PANE_STRIP_WIDTHS_STORAGE_KEY, NO_WIDTHS, StoredWidths);
  const preset = paneStripWidthPreset(stored, key);
  return {
    preset,
    className: WIDTH_CLASS[preset],
    attributes: { [PANE_STRIP_WIDTH_ATTRIBUTE]: key },
  };
}

function stepColumnWidth(column: HTMLElement, key: PaneStripWidthKey, direction: 1 | -1) {
  // Rendered before scrolling, so the column is measured at its new width.
  flushSync(() =>
    writeLocalStorageValue(
      PANE_STRIP_WIDTHS_STORAGE_KEY,
      (stored) =>
        withPaneStripWidth(
          stored,
          key,
          stepPaneStripWidth(key, paneStripWidthPreset(stored, key), direction),
        ),
      NO_WIDTHS,
      StoredWidths,
    ),
  );
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  column.scrollIntoView({
    inline: "nearest",
    block: "nearest",
    behavior: reducedMotion ? "auto" : "smooth",
  });
}

const asWidthKey = (value: string | null): PaneStripWidthKey | null =>
  value === "thread" || value?.startsWith("pane:") === true ? (value as PaneStripWidthKey) : null;

const shortcutLabel = () => (isMacPlatform(navigator.platform) ? "⌘⌥R" : "Ctrl+Alt+R");

/** Steps the width of the column holding focus with Mod+Alt+R, and back with Shift. */
export function usePaneStripWidthKeys(scroller: HTMLElement | null) {
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- listens for the width shortcut on the strip's DOM scroller, which portaled panes bubble keys to
  useEffect(() => {
    if (scroller === null) return;
    const mac = isMacPlatform(navigator.platform);
    const onKeyDown = (event: KeyboardEvent) => {
      const direction = paneStripWidthKeyDirection(event, mac);
      if (direction === null || !(event.target instanceof Element)) return;
      const column = event.target.closest<HTMLElement>(`[${PANE_STRIP_WIDTH_ATTRIBUTE}]`);
      const key = asWidthKey(column?.getAttribute(PANE_STRIP_WIDTH_ATTRIBUTE) ?? null);
      if (column === null || key === null) return;
      if (column.closest(`[${PANE_STRIP_ATTRIBUTE}]`) !== scroller) return;
      event.preventDefault();
      stepColumnWidth(column, key, direction);
    };
    scroller.addEventListener("keydown", onKeyDown);
    return () => scroller.removeEventListener("keydown", onKeyDown);
  }, [scroller]);
}

/** Steps its column through the width presets; Shift-click steps back. */
export function PaneStripWidthButton(props: {
  readonly widthKey: PaneStripWidthKey;
  readonly preset: PaneStripWidthPreset;
}) {
  const { widthKey, preset } = props;
  const next = PANE_STRIP_WIDTH_LABELS[stepPaneStripWidth(widthKey, preset, 1)].long;
  const previous = PANE_STRIP_WIDTH_LABELS[stepPaneStripWidth(widthKey, preset, -1)].long;
  const step = (event: MouseEvent<HTMLButtonElement>) => {
    const column = event.currentTarget.closest<HTMLElement>(`[${PANE_STRIP_WIDTH_ATTRIBUTE}]`);
    if (column !== null) stepColumnWidth(column, widthKey, event.shiftKey ? -1 : 1);
  };
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="xs"
            aria-label={`Width: ${PANE_STRIP_WIDTH_LABELS[preset].long}. Change to ${next}`}
            onClick={step}
          >
            {PANE_STRIP_WIDTH_LABELS[preset].short}
          </Button>
        }
      />
      <TooltipPopup side="bottom">
        Width: {PANE_STRIP_WIDTH_LABELS[preset].long}. Click for {next}, Shift-click for {previous}{" "}
        ({shortcutLabel()})
      </TooltipPopup>
    </Tooltip>
  );
}

/** The thread's width control, beside the thread's own header controls. */
export function PaneStripThreadWidthControl(props: { readonly preset: PaneStripWidthPreset }) {
  return (
    <div className="absolute top-[var(--workspace-controls-top)] right-[var(--workspace-controls-right)] z-50 flex h-[var(--workspace-topbar-height)] w-10 items-center justify-end [-webkit-app-region:no-drag]">
      <PaneStripWidthButton widthKey="thread" preset={props.preset} />
    </div>
  );
}
