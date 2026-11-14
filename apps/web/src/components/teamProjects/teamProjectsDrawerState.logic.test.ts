import { describe, expect, it } from "vite-plus/test";

import {
  resolveTeamProjectsDrawerOpen,
  teamProjectsDrawerToggle,
} from "./teamProjectsDrawerState.logic";

describe("teamProjectsDrawerToggle", () => {
  it.each([
    ["opens a closed graph", true, false, false, { open: true, closeTerminal: false }],
    ["closes a shown graph", true, true, false, { open: false, closeTerminal: false }],
    ["opens over the terminal", true, false, true, { open: true, closeTerminal: true }],
    [
      "brings back a graph the terminal hides instead of closing it",
      true,
      true,
      true,
      { open: true, closeTerminal: true },
    ],
    [
      "off a thread, shows the graph in the last thread over its terminal",
      false,
      false,
      true,
      { open: true, closeTerminal: true },
    ],
    [
      "off a thread, shows a graph that is already on",
      false,
      true,
      false,
      { open: true, closeTerminal: true },
    ],
  ] as const)("%s", (_name, onThread, open, terminalOpen, expected) => {
    expect(teamProjectsDrawerToggle({ onThread, open, terminalOpen })).toEqual({
      ...expected,
      leaveForThread: !onThread,
    });
  });
});

describe("resolveTeamProjectsDrawerOpen", () => {
  it.each([
    ["is on by default where a catalog is set", null, true, true],
    ["stays off by default without a catalog", null, false, false],
    ["stays closed once the user closes it", false, true, false],
    ["stays open once the user opens it, catalog or not", true, false, true],
  ] as const)("%s", (_name, stored, catalogSet, expected) => {
    expect(resolveTeamProjectsDrawerOpen(stored, catalogSet)).toBe(expected);
  });
});
