import { describe, expect, it } from "vite-plus/test";

import type { PaneStripColumn } from "./paneStrip.logic";
import {
  paneStripRevealLeft,
  paneStripStepLeft,
  paneStripWheelDirection,
} from "./paneStripMoves.logic";

// Timeline 300, thread 1000, two panes of 600, in a 1200 viewport: the strip scrolls to 1300.
const columns: PaneStripColumn[] = [
  { label: "Timeline", left: 0, width: 300 },
  { label: "Thread", left: 300, width: 1000 },
  { label: "Diff", left: 1300, width: 600 },
  { label: "New pane", left: 1900, width: 600 },
];
const view = (scrollLeft: number) => ({ scrollLeft, viewportWidth: 1200, maxLeft: 1300 });

describe("paneStripRevealLeft", () => {
  it.each([
    ["a column already in full", "Thread", 300, null],
    ["a pane peeking in at the right, at the nearest start that shows it", "Diff", 300, 1300],
    ["the timeline, from the thread", "Timeline", 300, 0],
    ["the last column, at the end of the strip", "New pane", 300, 1300],
    ["the thread, from the panes", "Thread", 1300, 300],
  ])("%s", (_, label, scrollLeft, expected) => {
    const target = columns.find((column) => column.label === label)!;
    expect(paneStripRevealLeft(columns, target, view(scrollLeft))).toBe(expected);
  });

  it("aligns a column wider than the strip at its start", () => {
    const wide = { label: "Wide", left: 300, width: 2000 };
    expect(paneStripRevealLeft([columns[0]!, wide], wide, view(0))).toBe(300);
  });
});

describe("paneStripStepLeft", () => {
  it.each([
    [0, 1, 300],
    [300, 1, 1300],
    [1300, 1, null],
    [1300, -1, 300],
    [300, -1, 0],
    [0, -1, null],
    // Mid-way between starts, a step goes to the next start that way.
    [800, 1, 1300],
    [800, -1, 300],
  ] as const)("from %d by %d", (from, direction, expected) => {
    expect(paneStripStepLeft(columns, from, 1300, direction)).toBe(expected);
  });
});

describe("paneStripWheelDirection", () => {
  const wheel = { shiftKey: true, deltaX: 0, deltaY: 0, deltaMode: 0 };
  it.each([
    ["a mouse notch down", { ...wheel, deltaY: 100, wheelDelta: -120 }, 1],
    ["a mouse notch up", { ...wheel, deltaY: -100, wheelDelta: 120 }, -1],
    ["a notch macOS turned sideways", { ...wheel, deltaX: 4, wheelDelta: -120 }, 1],
    ["a line-mode wheel", { ...wheel, deltaY: -3, deltaMode: 1 }, -1],
    ["a trackpad with shift held", { ...wheel, deltaY: 7, wheelDelta: -21 }, null],
    ["a wheel without shift", { ...wheel, shiftKey: false, deltaY: 100, wheelDelta: -120 }, null],
  ])("%s", (_, event, expected) => {
    expect(paneStripWheelDirection(event)).toBe(expected);
  });
});
