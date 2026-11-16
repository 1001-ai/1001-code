import { useEffect } from "react";
import { create } from "zustand";

import { closeThreadFind, useThreadFindStore } from "../chat/threadFindStore";
import {
  LAMP_LAYER_CLOSED,
  canToggleLampLayer,
  isLampLayerOpenIn,
  lampLayerClosed,
  lampLayerSharesThreadWithFind,
  lampLayerToggled,
  lampPromptSent,
  lampThreadCovered,
  lampThreadHidden,
  lampThreadShown,
  type LampLayerState,
} from "./lampLayer.logic";

const useLampLayerStore = create<LampLayerState>(() => LAMP_LAYER_CLOSED);

export function closeLampLayer(): void {
  useLampLayerStore.setState(lampLayerClosed);
}

/** Opens the layer over the thread on screen, or closes it. Opening closes that thread's find. */
export function toggleLampLayer(): void {
  const next = lampLayerToggled(useLampLayerStore.getState());
  if (lampLayerSharesThreadWithFind(next, useThreadFindStore.getState().threadKey)) {
    closeThreadFind();
  }
  useLampLayerStore.setState(next);
}

/**
 * Wraps the send a thread's prompt box calls, so sending a prompt leaves the layer over that
 * thread. The prompt box calls it once the draft has passed its own checks.
 */
export function closingLampLayerOnSend<Args extends readonly unknown[], Result>(
  threadKey: string,
  send: (...args: Args) => Result,
): (...args: Args) => Result {
  return (...args) => {
    useLampLayerStore.setState((state) => lampPromptSent(state, threadKey));
    return send(...args);
  };
}

export function readCanToggleLampLayer(): boolean {
  return canToggleLampLayer(useLampLayerStore.getState());
}

// The other half of the find rule: a find that opens over the layer's thread closes the layer.
useThreadFindStore.subscribe((find) => {
  if (lampLayerSharesThreadWithFind(useLampLayerStore.getState(), find.threadKey)) {
    closeLampLayer();
  }
});

export function useLampLayerOpen(threadKey: string | null): boolean {
  return useLampLayerStore((state) => isLampLayerOpenIn(state, threadKey));
}

/** What the command palette needs: whether the layer can be toggled, and which way. */
export function useLampLayerToggleState(): "open" | "closed" | null {
  return useLampLayerStore((state) =>
    canToggleLampLayer(state) ? (state.openIn === null ? "closed" : "open") : null,
  );
}

/**
 * Names the thread whose title bar shows the button, for as long as it shows it. While a
 * maximized panel covers that thread's chat, there is nothing for a layer to cover.
 */
export function useLampThread(threadKey: string, covered: boolean): void {
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the shortcut and the palette act outside React, so the store has to know which thread's button is on screen
  useEffect(() => {
    useLampLayerStore.setState((state) =>
      covered ? lampThreadCovered(state, threadKey) : lampThreadShown(state, threadKey),
    );
    return () => useLampLayerStore.setState((state) => lampThreadHidden(state, threadKey));
  }, [threadKey, covered]);
}
