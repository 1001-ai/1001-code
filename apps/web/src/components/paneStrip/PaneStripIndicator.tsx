import { useEffect, useState } from "react";

import { useMediaQuery } from "../../hooks/useMediaQuery";
import { observeResize } from "../../lib/observeResize";
import { cn } from "../../lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { type PaneStripColumn, paneStripColumnsOnScreen } from "./paneStrip.logic";

interface IndicatorState {
  readonly columns: ReadonlyArray<PaneStripColumn>;
  readonly onScreen: ReadonlyArray<boolean>;
}

const EMPTY: IndicatorState = { columns: [], onScreen: [] };

function readColumns(scroller: HTMLElement): PaneStripColumn[] {
  return [...scroller.querySelectorAll<HTMLElement>("[data-pane-strip-label]")]
    .filter((column) => column.closest("[data-pane-strip]") === scroller)
    .map((column) => ({
      label: column.dataset.paneStripLabel ?? "",
      left: column.offsetLeft,
      width: column.offsetWidth,
    }));
}

function readState(scroller: HTMLElement): IndicatorState {
  const columns = readColumns(scroller);
  return {
    columns,
    onScreen: paneStripColumnsOnScreen(columns, scroller.scrollLeft, scroller.clientWidth),
  };
}

const sameState = (a: IndicatorState, b: IndicatorState) =>
  a.columns.length === b.columns.length &&
  a.columns.every(
    (column, index) =>
      column.label === b.columns[index]?.label &&
      column.left === b.columns[index]?.left &&
      a.onScreen[index] === b.onScreen[index],
  );

/**
 * One mark for each column of the strip, bright for the ones on screen, so a strip at rest still
 * shows there is an Inbox to the left and panes to the right. A mark scrolls to its column.
 */
export function PaneStripIndicator(props: { readonly scroller: HTMLElement | null }) {
  const { scroller } = props;
  const [state, setState] = useState(EMPTY);
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- follows the strip scroller's DOM: its scroll position, its size and the columns ChatView portals into it
  useEffect(() => {
    if (scroller === null) return;
    // Scroll events arrive every frame; the marks only change when a column crosses an edge.
    const update = () => {
      const next = readState(scroller);
      setState((current) => (sameState(current, next) ? current : next));
    };
    update();
    scroller.addEventListener("scroll", update, { passive: true });
    const stopObservingSize = observeResize(scroller, update);
    const mutation = new MutationObserver(update);
    mutation.observe(scroller, { childList: true, subtree: true, attributeFilter: ["class"] });
    return () => {
      scroller.removeEventListener("scroll", update);
      stopObservingSize();
      mutation.disconnect();
    };
  }, [scroller]);

  if (scroller === null || state.columns.length < 2) return null;
  return (
    <nav
      aria-label="Panes"
      className="pointer-events-none absolute inset-x-0 bottom-0 z-10 flex justify-center"
    >
      <div className="pointer-events-auto flex">
        {state.columns.map((column, index) => (
          <Tooltip key={`${column.label}:${column.left}`}>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-label={`Go to ${column.label}`}
                  aria-current={state.onScreen[index] ? "true" : undefined}
                  className="group cursor-pointer px-0.5 pt-2 pb-1 outline-none"
                  onClick={() =>
                    scroller.scrollTo({
                      left: column.left,
                      behavior: reducedMotion ? "auto" : "smooth",
                    })
                  }
                >
                  <span
                    className={cn(
                      "block h-1 w-6 rounded-full group-hover:bg-foreground/70 group-focus-visible:bg-ring",
                      state.onScreen[index] ? "bg-foreground/50" : "bg-foreground/15",
                    )}
                  />
                </button>
              }
            />
            <TooltipPopup side="top">{column.label}</TooltipPopup>
          </Tooltip>
        ))}
      </div>
    </nav>
  );
}
