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
    ["is on by default where a catalog is set", null, true, undefined, true],
    ["stays off by default without a catalog", null, false, undefined, false],
    ["stays closed once the user closes it", false, true, true, false],
    ["stays open once the user opens it, catalog or not", true, false, false, true],
    ["while loading, stays on where the catalog was set last time", null, null, true, true],
    ["while loading, stays off where no catalog was set last time", null, null, false, false],
    ["while loading an environment never seen, stays off", null, null, undefined, false],
    ["follows the loaded catalog over what it had last time", null, false, true, false],
  ] as const)("%s", (_name, stored, catalogSet, remembered, expected) => {
    expect(resolveTeamProjectsDrawerOpen(stored, catalogSet, remembered)).toBe(expected);
  });
});
