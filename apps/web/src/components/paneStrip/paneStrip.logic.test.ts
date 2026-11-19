import { describe, expect, it } from "vite-plus/test";

import { paneStripColumnsOnScreen, shouldRevealActivePane } from "./paneStrip.logic";

describe("shouldRevealActivePane", () => {
  const at = (threadKey: string, activeSurfaceId: string | null) => ({
    threadKey,
    activeSurfaceId,
  });

  it.each([
    { name: "first render", previous: null, next: at("a", "diff"), expected: false },
    {
      name: "another thread opens",
      previous: at("a", "diff"),
      next: at("b", "files"),
      expected: false,
    },
    {
      name: "a pane becomes active",
      previous: at("a", "diff"),
      next: at("a", "files"),
      expected: true,
    },
    {
      name: "the first pane opens",
      previous: at("a", null),
      next: at("a", "diff"),
      expected: true,
    },
    { name: "nothing changed", previous: at("a", "diff"), next: at("a", "diff"), expected: false },
    {
      name: "the last pane closes",
      previous: at("a", "diff"),
      next: at("a", null),
      expected: false,
    },
  ])("$name", ({ previous, next, expected }) => {
    expect(shouldRevealActivePane(previous, next)).toBe(expected);
  });
});

describe("paneStripColumnsOnScreen", () => {
  const columns = ["Inbox", "Thread", "Diff", "Terminal"].map((label, index) => ({
    label,
    left: index * 500,
    width: 500,
  }));

  it.each([
    { name: "resting on the thread", scrollLeft: 500, expected: [false, true, true, false] },
    { name: "swiped to the Inbox", scrollLeft: 0, expected: [true, true, false, false] },
    { name: "between two rests", scrollLeft: 750, expected: [false, true, true, true] },
  ])("$name", ({ scrollLeft, expected }) => {
    expect(paneStripColumnsOnScreen(columns, scrollLeft, 1000)).toEqual(expected);
  });
});
