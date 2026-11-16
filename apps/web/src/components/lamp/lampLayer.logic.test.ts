import { describe, expect, it } from "vite-plus/test";

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
} from "./lampLayer.logic";

const onThread = (threadKey: string) => lampThreadShown(LAMP_LAYER_CLOSED, threadKey);

describe("lamp layer", () => {
  it("opens over the thread on screen and closes again", () => {
    const open = lampLayerToggled(onThread("a"));
    expect(isLampLayerOpenIn(open, "a")).toBe(true);
    expect(isLampLayerOpenIn(open, "b")).toBe(false);
    expect(isLampLayerOpenIn(lampLayerToggled(open), "a")).toBe(false);
    expect(isLampLayerOpenIn(lampLayerClosed(open), "a")).toBe(false);
  });

  it("does nothing with no thread on screen", () => {
    expect(canToggleLampLayer(LAMP_LAYER_CLOSED)).toBe(false);
    expect(lampLayerToggled(LAMP_LAYER_CLOSED)).toBe(LAMP_LAYER_CLOSED);
    expect(isLampLayerOpenIn(LAMP_LAYER_CLOSED, null)).toBe(false);
  });

  it("closes when another thread comes on screen, and stays closed on the way back", () => {
    const open = lampLayerToggled(onThread("a"));
    const switched = lampThreadShown(lampThreadHidden(open, "a"), "b");
    expect(switched).toEqual({ target: "b", openIn: null });
    const back = lampThreadShown(lampThreadHidden(switched, "b"), "a");
    expect(isLampLayerOpenIn(back, "a")).toBe(false);
  });

  it("stays open while its button moves, and can still be closed without it", () => {
    const open = lampLayerToggled(onThread("a"));
    const buttonGone = lampThreadHidden(open, "a");
    expect(isLampLayerOpenIn(buttonGone, "a")).toBe(true);
    expect(canToggleLampLayer(buttonGone)).toBe(true);
    expect(isLampLayerOpenIn(lampLayerToggled(buttonGone), "a")).toBe(false);
    expect(isLampLayerOpenIn(lampThreadShown(buttonGone, "a"), "a")).toBe(true);
  });

  it("closes and cannot be opened while a maximized panel covers the chat", () => {
    const open = lampLayerToggled(onThread("a"));
    const covered = lampThreadCovered(lampThreadHidden(open, "a"), "a");
    expect(covered).toEqual(LAMP_LAYER_CLOSED);
    expect(canToggleLampLayer(covered)).toBe(false);
    expect(lampThreadCovered(onThread("b"), "a")).toEqual(onThread("b"));
    expect(canToggleLampLayer(lampThreadShown(covered, "a"))).toBe(true);
  });

  it("closes when a prompt is sent from its thread, not from another", () => {
    const open = lampLayerToggled(onThread("a"));
    expect(lampPromptSent(open, "b")).toBe(open);
    expect(lampPromptSent(open, "a")).toEqual(onThread("a"));
    expect(lampPromptSent(onThread("a"), "a")).toEqual(onThread("a"));
  });

  it("ignores a button leaving that is not the one on screen", () => {
    const state = onThread("b");
    expect(lampThreadHidden(state, "a")).toBe(state);
  });

  it("shares a thread with find only when both are over the same one", () => {
    const open = lampLayerToggled(onThread("a"));
    expect(lampLayerSharesThreadWithFind(open, "a")).toBe(true);
    expect(lampLayerSharesThreadWithFind(open, "b")).toBe(false);
    expect(lampLayerSharesThreadWithFind(open, null)).toBe(false);
    expect(lampLayerSharesThreadWithFind(onThread("a"), "a")).toBe(false);
  });
});
