import { describe, expect, it } from "vite-plus/test";

import { paneStripInboxThreadId, shouldRevealActivePane } from "./paneStrip.logic";

describe("paneStripInboxThreadId", () => {
  it.each([
    { name: "another thread is open", route: "thread-1", inbox: "inbox", expected: "inbox" },
    { name: "the Inbox itself is open", route: "inbox", inbox: "inbox", expected: null },
    { name: "the project has no Inbox yet", route: "thread-1", inbox: null, expected: null },
    { name: "no thread is open", route: null, inbox: "inbox", expected: null },
  ])("$name", ({ route, inbox, expected }) => {
    expect(paneStripInboxThreadId({ routeThreadId: route, inboxThreadId: inbox })).toBe(expected);
  });
});

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
