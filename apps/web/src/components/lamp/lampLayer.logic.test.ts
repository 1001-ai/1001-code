import { describe, expect, it } from "vite-plus/test";

import {
  LAMP_LAYER_CLOSED,
  canToggleLampLayer,
  isLampLayerOpenIn,
  isLampTalkKey,
  lampHoldsKeyboard,
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
    // Switching to a thread whose panel is maximized closes a layer left open over the last one.
    const switched = lampThreadCovered(lampThreadHidden(open, "a"), "b");
    expect(switched).toEqual(LAMP_LAYER_CLOSED);
    expect(isLampLayerOpenIn(lampThreadShown(switched, "a"), "a")).toBe(false);
    const openElsewhere = lampLayerToggled(onThread("b"));
    expect(lampThreadCovered(openElsewhere, "a")).toEqual(openElsewhere);
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

  it("has the keyboard while it is open, except in a text field or under a popup", () => {
    const layer = { open: true, leaving: false, inEditable: false, popupOpen: false };
    expect(lampHoldsKeyboard(layer)).toBe(true);
    expect(lampHoldsKeyboard({ ...layer, open: false })).toBe(false);
    // Closed in the store but still fading out on screen: a held Space still types nothing.
    expect(lampHoldsKeyboard({ ...layer, open: false, leaving: true })).toBe(true);
    expect(lampHoldsKeyboard({ ...layer, open: false, leaving: true, inEditable: true })).toBe(
      false,
    );
    expect(lampHoldsKeyboard({ ...layer, inEditable: true })).toBe(false);
    expect(lampHoldsKeyboard({ ...layer, popupOpen: true })).toBe(false);
  });

  it("takes Space on its own, and its repeats, as the key to talk", () => {
    const space = {
      key: " ",
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      isComposing: false,
      keyCode: 32,
    };
    expect(isLampTalkKey(space)).toBe(true);
    // A held Space repeats: the layer keeps taking it, so none of them types a space.
    const repeated = { ...space, repeat: true };
    expect(isLampTalkKey(repeated)).toBe(true);
    expect(isLampTalkKey({ ...space, key: "a", keyCode: 65 })).toBe(false);
    expect(isLampTalkKey({ ...space, metaKey: true })).toBe(false);
    expect(isLampTalkKey({ ...space, ctrlKey: true })).toBe(false);
    expect(isLampTalkKey({ ...space, altKey: true })).toBe(false);
    expect(isLampTalkKey({ ...space, isComposing: true })).toBe(false);
    expect(isLampTalkKey({ ...space, keyCode: 229 })).toBe(false);
  });
});
