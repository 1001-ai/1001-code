import { useEffect, useRef } from "react";

import { readLocalApi } from "../../localApi";
import { previewStateAtom } from "../../previewStateStore";
import { type RightPanelSurface, useRightPanelStore } from "../../rightPanelStore";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { agentControlledBrowserCloseConfirmation } from "../ChatView.logic";
import { PANE_STRIP_ATTRIBUTE } from "./paneStrip.logic";
import { revealColumn } from "./PaneStripMoves";
import { usePaneStripPlacement } from "./paneStripPlacement";
import {
  type PaneStripOpener,
  paneStripOpenerFromEvent,
  paneStripReplacement,
} from "./paneStripReplace.logic";

const paneElement = (host: HTMLElement, surfaceId: string) =>
  [...host.children].find(
    (pane): pane is HTMLElement =>
      pane instanceof HTMLElement && pane.dataset.paneStripPane === surfaceId,
  );

/**
 * With panes opening outward the strip is a hierarchy: a pane opened from a column takes the place
 * to that column's right, and the panes that were there close. The store has no record of what
 * opened a pane, so the opener is the column last pressed.
 */
export function usePaneStripReplace(input: {
  readonly host: HTMLElement;
  readonly threadKey: string;
  /** The store's order, which is the drawn order while panes open outward. */
  readonly surfaces: ReadonlyArray<RightPanelSurface>;
  readonly titleOf: (surface: RightPanelSurface) => string;
  readonly onMove: ((surfaceId: string, toIndex: number) => void) | undefined;
  readonly onClose: (surface: RightPanelSurface) => void;
}) {
  const { host, threadKey, surfaces } = input;
  const [placement] = usePaneStripPlacement();
  // Only a pane the user opened replaces others; one an agent opened leaves this unchanged.
  const revision = useRightPanelStore(
    (state) => state.userActionRevisionByThreadKey[threadKey] ?? 0,
  );
  const opener = useRef<PaneStripOpener>(null);
  const seen = useRef<{
    threadKey: string;
    surfaces: ReadonlyArray<RightPanelSurface>;
    revision: number;
  } | null>(null);
  const settling = useRef<{ openedId: string; closing: ReadonlyArray<string> } | null>(null);
  const latest = useRef(input);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps the callbacks the store effect below calls current without re-running it
  useEffect(() => {
    latest.current = input;
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- listens on the window, where shortcuts are handled, for the press that names the opening column
  useEffect(() => {
    const scroller = host.closest<HTMLElement>(`[${PANE_STRIP_ATTRIBUTE}]`);
    const columnOf = (target: EventTarget | null) => {
      if (!(target instanceof Element) || scroller === null || !scroller.contains(target)) {
        return null;
      }
      const pane = target.closest<HTMLElement>("[data-pane-strip-pane]");
      if (pane !== null) return pane.dataset.paneStripPane ?? null;
      return target.closest('[data-pane-strip-label="Thread"]') === null ? null : "thread";
    };
    const note = (key: string | null, modified: boolean, target: EventTarget | null) => {
      const next = paneStripOpenerFromEvent({ key, modified, column: columnOf(target) });
      if (next !== undefined) opener.current = next;
    };
    const onPointerDown = (event: PointerEvent) => note(null, false, event.target);
    const onKeyDown = (event: KeyboardEvent) =>
      note(event.key, event.metaKey || event.ctrlKey || event.altKey, event.target);
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [host]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reacts to a pane the store just gained by moving and closing panes in that store, then scrolls the strip's DOM scroller
  useEffect(() => {
    const previous = seen.current;
    const ids: ReadonlyArray<string> = surfaces.map((surface) => surface.id);
    seen.current = { threadKey, surfaces, revision };

    const pending = settling.current;
    if (pending !== null && !pending.closing.some((id) => ids.includes(id))) {
      settling.current = null;
      const scroller = host.closest<HTMLElement>(`[${PANE_STRIP_ATTRIBUTE}]`);
      const pane = paneElement(host, pending.openedId);
      if (scroller !== null && pane !== undefined) revealColumn(scroller, pane);
    }

    if (
      placement !== "outward" ||
      previous === null ||
      previous.threadKey !== threadKey ||
      previous.revision === revision
    ) {
      return;
    }
    // The shortcut dispatcher listens on the window, so its open can land before the listener above.
    const event = window.event;
    const shortcut =
      event instanceof KeyboardEvent && (event.metaKey || event.ctrlKey || event.altKey);
    const replacement = paneStripReplacement({
      previous: previous.surfaces,
      surfaces,
      opener: shortcut ? null : opener.current,
    });
    if (replacement === null) return;
    const { onMove, onClose, titleOf } = latest.current;
    settling.current = {
      openedId: replacement.opened.id,
      closing: replacement.close.map((surface) => surface.id),
    };
    onMove?.(replacement.opened.id, replacement.index);
    for (const surface of replacement.close) onClose(surface);
    // A pane the user keeps is already right of the new one, so it ends up at the far right.
    void (async () => {
      for (const surface of replacement.ask) {
        // A terminal, and a browser an agent is using, ask on their own when closed.
        const asksOnClose =
          surface.kind === "terminal" ||
          agentControlledBrowserCloseConfirmation(
            [surface],
            appAtomRegistry.get(previewStateAtom(threadKey)).desktopByTabId,
          ) !== null;
        const close =
          asksOnClose ||
          (await readLocalApi()?.dialogs.confirm(
            `Close "${titleOf(surface)}" to make room for the pane you opened? Its page closes. Cancel keeps it open at the far right.`,
            { variant: "destructive" },
          ));
        if (close === true) latest.current.onClose(surface);
      }
    })();
  }, [host, placement, revision, surfaces, threadKey]);
}
