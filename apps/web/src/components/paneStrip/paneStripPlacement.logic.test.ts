import { describe, expect, it } from "vite-plus/test";

import type { RightPanelSurface } from "../../rightPanelStore";
import { orderPaneStripSurfaces } from "./paneStripPlacement.logic";

describe("orderPaneStripSurfaces", () => {
  const pane = (id: string, kind: RightPanelSurface["kind"]) => ({ id, kind });
  const opened = [
    pane("browser:b", "preview"),
    pane("terminal:2", "terminal"),
    pane("diff", "diff"),
    pane("board", "board"),
    pane("file:src/a.ts", "file"),
    pane("terminal:1", "terminal"),
    pane("browser:a", "preview"),
    pane("files", "files"),
  ];
  const ids = (surfaces: ReadonlyArray<{ id: string }>) => surfaces.map((surface) => surface.id);

  it("keeps opening order when panes open outward", () => {
    expect(orderPaneStripSurfaces(opened, "outward")).toBe(opened);
  });

  it("gives each kind its place, and keeps opening order within a kind", () => {
    expect(ids(orderPaneStripSurfaces(opened, "fixed"))).toEqual([
      "files",
      "file:src/a.ts",
      "diff",
      "terminal:2",
      "terminal:1",
      "browser:b",
      "browser:a",
      "board",
    ]);
  });

  it("leaves the opening order it was given untouched", () => {
    const before = ids(opened);
    orderPaneStripSurfaces(opened, "fixed");
    expect(ids(opened)).toEqual(before);
  });
});
