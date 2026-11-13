import { describe, expect, it } from "vite-plus/test";

import { sendKeepsReaderPlace } from "./sendKeepsPlace.logic";
import { FOLLOWING, initialTimelineFollow, transitionTimelineFollow } from "./timelineViewport";

describe("sendKeepsReaderPlace", () => {
  it("moves to the new turn while the live end is followed or still in view", () => {
    expect(sendKeepsReaderPlace(FOLLOWING)).toBe(false);
    expect(sendKeepsReaderPlace(transitionTimelineFollow(FOLLOWING, { type: "navigated" }))).toBe(
      false,
    );
  });

  it("keeps the place of a reader who scrolled up or opened the thread above the end", () => {
    const scrolledUp = transitionTimelineFollow(
      transitionTimelineFollow(FOLLOWING, { type: "navigated" }),
      { type: "leftEnd" },
    );
    expect(sendKeepsReaderPlace(scrolledUp)).toBe(true);
    expect(sendKeepsReaderPlace(initialTimelineFollow(false))).toBe(true);
    expect(sendKeepsReaderPlace(transitionTimelineFollow(scrolledUp, { type: "reachedEnd" }))).toBe(
      false,
    );
  });
});
