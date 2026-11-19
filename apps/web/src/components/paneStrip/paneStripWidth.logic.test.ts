import { describe, expect, it } from "vite-plus/test";

import {
  paneStripWidthPreset,
  stepPaneStripWidth,
  withPaneStripWidth,
} from "./paneStripWidth.logic";

describe("paneStripWidthPreset", () => {
  it.each([
    { name: "thread default", stored: {}, key: "thread", expected: "fit" },
    { name: "pane default", stored: {}, key: "pane:diff", expected: "half" },
    { name: "stored", stored: { "pane:diff": "third" }, key: "pane:diff", expected: "third" },
    { name: "other kind", stored: { "pane:diff": "third" }, key: "pane:files", expected: "half" },
    {
      name: "thread-only preset",
      stored: { "pane:diff": "fit" },
      key: "pane:diff",
      expected: "half",
    },
    { name: "unknown value", stored: { thread: "wide" }, key: "thread", expected: "fit" },
  ] as const)("$name", ({ stored, key, expected }) => {
    expect(paneStripWidthPreset(stored, key)).toBe(expected);
  });
});

describe("stepPaneStripWidth", () => {
  it.each([
    { key: "pane:diff", current: "half", direction: 1, expected: "two-thirds" },
    { key: "pane:diff", current: "full", direction: 1, expected: "third" },
    { key: "pane:diff", current: "third", direction: -1, expected: "full" },
    { key: "thread", current: "fit", direction: 1, expected: "third" },
    // Narrowing the thread is one Shift-click to undo.
    { key: "thread", current: "third", direction: -1, expected: "fit" },
    { key: "thread", current: "full", direction: 1, expected: "fit" },
  ] as const)("$key $current $direction", ({ key, current, direction, expected }) => {
    expect(stepPaneStripWidth(key, current, direction)).toBe(expected);
  });
});

describe("withPaneStripWidth", () => {
  it("stores a choice and drops a default", () => {
    const stored = withPaneStripWidth({ thread: "half" }, "pane:diff", "third");
    expect(stored).toEqual({ thread: "half", "pane:diff": "third" });
    expect(withPaneStripWidth(stored, "thread", "fit")).toEqual({ "pane:diff": "third" });
  });
});
