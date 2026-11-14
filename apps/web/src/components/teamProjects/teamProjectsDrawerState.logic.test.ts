import { describe, expect, it } from "vite-plus/test";

import {
  resolveTeamProjectsDrawerOpen,
  teamProjectsDrawerToggle,
} from "./teamProjectsDrawerState.logic";

describe("teamProjectsDrawerToggle", () => {
  it.each([
    [
      "opens a closed graph",
      { open: false, terminalOpen: false },
      { open: true, closeTerminal: false },
    ],
    [
      "closes a shown graph",
      { open: true, terminalOpen: false },
      { open: false, closeTerminal: false },
    ],
    [
      "opens over the terminal",
      { open: false, terminalOpen: true },
      { open: true, closeTerminal: true },
    ],
    [
      "brings back a graph the terminal hides instead of closing it",
      { open: true, terminalOpen: true },
      { open: true, closeTerminal: true },
    ],
  ])("in a thread, %s", (_name, state, expected) => {
    expect(teamProjectsDrawerToggle({ onThread: true, ...state })).toEqual({
      ...expected,
      leaveForThread: false,
    });
  });

  it("off a thread, opens the graph and goes back to the last thread", () => {
    expect(teamProjectsDrawerToggle({ onThread: false, open: true, terminalOpen: false })).toEqual({
      open: true,
      closeTerminal: false,
      leaveForThread: true,
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
