import { describe, expect, it } from "vite-plus/test";

import {
  citationJumpKey,
  isNearAnchor,
  isReaderScroll,
  jumpBackTarget,
  jumpBackVisible,
  nextJumpBack,
  type JumpBackAnchor,
  type JumpBackEvent,
  type JumpBackState,
} from "./jumpBack.logic";

const visit = { threadKey: "env:thread" };
const anchor: JumpBackAnchor = {
  atEnd: false,
  rows: [
    { rowId: "a", offsetWithinRow: 40 },
    { rowId: "b", offsetWithinRow: -200 },
  ],
};

function run(...events: ReadonlyArray<JumpBackEvent<typeof visit>>) {
  return events.reduce<JumpBackState<typeof visit> | null>(nextJumpBack, null);
}

const jump = { type: "jump", visit, anchor } as const;
const far = { type: "sample", near: false } as const;
const near = { type: "sample", near: true } as const;
const wheel = {
  type: "navigation",
  navigation: { source: "wheel", direction: "down" },
} as const;

describe("nextJumpBack", () => {
  it("shows Back once the jump moves the viewport away, not before", () => {
    expect(jumpBackVisible(run(jump), visit)).toBe(false);
    expect(jumpBackVisible(run(jump, near), visit)).toBe(false);
    expect(jumpBackVisible(run(jump, near, far), visit)).toBe(true);
    // A new jump replaces the slot and waits for its own move.
    expect(jumpBackVisible(run(jump, far, jump), visit)).toBe(false);
  });

  it("hides when the reader scrolls back near the spot", () => {
    expect(run(jump, far, wheel, near)).toBeNull();
    // Composer page keys reach the timeline as commands; arriving near still counts.
    expect(
      run(
        jump,
        far,
        { type: "navigation", navigation: { source: "command", releasesFollow: true } },
        near,
      ),
    ).toBeNull();
  });

  it("hides on Scroll to end, which re-arms follow", () => {
    expect(
      run(jump, far, {
        type: "navigation",
        navigation: { source: "command", releasesFollow: false },
      }),
    ).toBeNull();
  });

  it("drops a jump the reader scrolls past before it moved", () => {
    expect(run(jump, wheel)).toBeNull();
    // The citation's own follow release is a command, not the reader.
    expect(
      run(jump, { type: "navigation", navigation: { source: "command", releasesFollow: true } }),
    ).not.toBeNull();
  });

  it("keeps Back while the reader scrolls elsewhere", () => {
    expect(jumpBackVisible(run(jump, far, wheel, far), visit)).toBe(true);
  });

  it("belongs to one visit to the thread", () => {
    expect(jumpBackVisible(run(jump, far), { threadKey: "env:thread" })).toBe(false);
  });
});

describe("isReaderScroll", () => {
  it("counts scrolling gestures, not clicks in the timeline or UI commands", () => {
    expect(isReaderScroll({ source: "wheel", direction: "up" })).toBe(true);
    expect(isReaderScroll({ source: "touch" })).toBe(true);
    expect(isReaderScroll({ source: "key", key: "PageUp", direction: "up" })).toBe(true);
    expect(isReaderScroll({ source: "scroll" })).toBe(true);
    expect(isReaderScroll({ source: "pointer", onScrollbar: true })).toBe(true);
    expect(isReaderScroll({ source: "pointer", onScrollbar: false })).toBe(false);
    expect(isReaderScroll({ source: "command", releasesFollow: true })).toBe(false);
  });
});

describe("isNearAnchor", () => {
  const measure = (offsets: Record<string, number>, atEnd = false) => ({
    atEnd,
    viewportHeight: 600,
    offsetWithinRow: (rowId: string) => offsets[rowId],
  });

  it("compares the first rendered anchored row within a third of the viewport", () => {
    expect(isNearAnchor(anchor, measure({ a: 40 + 200 }))).toBe(true);
    expect(isNearAnchor(anchor, measure({ a: 40 + 201 }))).toBe(false);
    expect(isNearAnchor(anchor, measure({ b: -200 - 150 }))).toBe(true);
    expect(isNearAnchor(anchor, measure({}))).toBe(false);
  });

  it("treats a place at the end as the end", () => {
    const end: JumpBackAnchor = { atEnd: true, rows: [] };
    expect(isNearAnchor(end, measure({}, true))).toBe(true);
    expect(isNearAnchor(end, measure({}, false))).toBe(false);
  });
});

describe("jumpBackTarget", () => {
  it("goes to the first anchored row the list still has, or the end", () => {
    expect(jumpBackTarget(anchor, () => true)).toEqual({
      kind: "row",
      rowId: "a",
      offsetWithinRow: 40,
    });
    expect(jumpBackTarget(anchor, (rowId) => rowId === "b")).toEqual({
      kind: "row",
      rowId: "b",
      offsetWithinRow: -200,
    });
    expect(jumpBackTarget(anchor, () => false)).toBeNull();
    expect(jumpBackTarget({ atEnd: true, rows: [] }, () => false)).toEqual({ kind: "end" });
  });
});

describe("citationJumpKey", () => {
  const thread = { environmentId: "env", threadId: "thread" };

  it("records a new citation activation on this thread once", () => {
    expect(citationJumpKey(thread, "k1", thread, null)).toBe("k1");
    expect(citationJumpKey(thread, "k1", thread, "k1")).toBeNull();
    expect(citationJumpKey(thread, "k2", thread, "k1")).toBe("k2");
  });

  it("ignores other threads and locations without a citation", () => {
    expect(
      citationJumpKey({ environmentId: "env", threadId: "other" }, "k", thread, null),
    ).toBeNull();
    expect(
      citationJumpKey({ environmentId: "env2", threadId: "thread" }, "k", thread, null),
    ).toBeNull();
    expect(citationJumpKey(null, "k", thread, null)).toBeNull();
  });
});
