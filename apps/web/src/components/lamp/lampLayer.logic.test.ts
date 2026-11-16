import { describe, expect, it, vi } from "vite-plus/test";

import {
  LAMP_LAYER_CLOSED,
  afterLampMotion,
  canToggleLampLayer,
  coverLampSiblings,
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

/** One of the chat's layers, as far as covering it goes: its attributes and its animations. */
function chatLayer(attribute?: string) {
  const attributes = new Set(attribute === undefined ? [] : [attribute]);
  const animations: Array<{
    keyframes: Keyframe[];
    options: KeyframeAnimationOptions;
    cancelled: boolean;
  }> = [];
  return {
    attributes,
    animations,
    hasAttribute: (name: string) => attributes.has(name),
    setAttribute: (name: string) => void attributes.add(name),
    removeAttribute: (name: string) => void attributes.delete(name),
    animate: (keyframes: Keyframe[], options: KeyframeAnimationOptions) => {
      const animation = { keyframes, options, cancelled: false };
      animations.push(animation);
      return { cancel: () => void (animation.cancelled = true) };
    },
  };
}

describe("lamp layer motion", () => {
  const never = { finished: new Promise<never>(() => {}) };

  it("covers the chat's layers, fades out the ones above the glass, and gives each back", () => {
    const list = chatLayer();
    const minimap = chatLayer();
    const coveredAlready = chatLayer("inert");
    const timing = { duration: 240, easing: "ease-out" };
    const uncover = coverLampSiblings(
      [list, minimap, coveredAlready],
      (layer) => layer === minimap,
      timing,
    );
    expect([list.attributes.has("inert"), minimap.attributes.has("inert")]).toEqual([true, true]);
    expect(list.animations).toEqual([]);
    const hidden = { keyframes: [{}, { opacity: 0 }], options: { ...timing, fill: "forwards" } };
    expect(minimap.animations).toEqual([{ ...hidden, cancelled: false }]);

    uncover();
    expect([list.attributes.has("inert"), minimap.attributes.has("inert")]).toEqual([false, false]);
    // Back to its own CSS opacity, which for hover-only chrome is hidden.
    expect(minimap.animations).toEqual([
      { ...hidden, cancelled: true },
      { keyframes: [{ opacity: 0 }, {}], options: timing, cancelled: false },
    ]);
    // What was inert before is not this layer's to give back.
    expect(coveredAlready.attributes.has("inert")).toBe(true);
    expect(coveredAlready.animations).toEqual([]);
  });

  it("leaves once: after the motion's time in a tab that never paints, or when it settles", async () => {
    vi.useFakeTimers();
    try {
      const unpainted = vi.fn();
      afterLampMotion([never, never], 240, unpainted);
      await vi.advanceTimersByTimeAsync(239);
      expect(unpainted).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(unpainted).toHaveBeenCalledTimes(1);

      // Finished or cancelled, the animations settling is enough, and the timer adds nothing.
      const painted = vi.fn();
      const cancelled = { finished: Promise.reject(new Error("cancelled")) };
      afterLampMotion([{ finished: Promise.resolve() }, cancelled], 240, painted);
      await vi.advanceTimersByTimeAsync(0);
      expect(painted).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(240);
      expect(painted).toHaveBeenCalledTimes(1);

      // Cancelled, as when the layer opens again while it leaves.
      const reopened = vi.fn();
      afterLampMotion([{ finished: Promise.resolve() }, never], 240, reopened)();
      await vi.advanceTimersByTimeAsync(240);
      expect(reopened).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
