import { describe, expect, it } from "vite-plus/test";

import type { RightPanelSurface } from "../../rightPanelStore";
import { paneStripOpenerFromEvent, paneStripReplacement } from "./paneStripReplace.logic";

const pane = (id: string, kind: RightPanelSurface["kind"]) => ({ id, kind });
const ids = (surfaces: ReadonlyArray<{ id: string }>) => surfaces.map((surface) => surface.id);

describe("paneStripReplacement", () => {
  const files = pane("files", "files");
  const fileA = pane("file:a.ts", "file");
  const terminal = pane("terminal:1", "terminal");
  const browser = pane("browser:1", "preview");
  const diff = pane("diff", "diff");
  const fileB = pane("file:b.ts", "file");
  const before = [files, fileA, terminal, diff, browser];

  it("replaces everything right of the opening pane, asking about running panes", () => {
    const result = paneStripReplacement({
      previous: before,
      surfaces: [...before, fileB],
      opener: { kind: "pane", surfaceId: "files" },
    });
    expect(result?.opened).toBe(fileB);
    expect(result?.index).toBe(1);
    expect(ids(result?.close ?? [])).toEqual(["file:a.ts", "diff"]);
    expect(ids(result?.ask ?? [])).toEqual(["terminal:1", "browser:1"]);
  });

  it("replaces every pane when the main chat opens one", () => {
    const result = paneStripReplacement({
      previous: before,
      surfaces: [...before, fileB],
      opener: { kind: "thread" },
    });
    expect(result?.index).toBe(0);
    expect(ids(result?.close ?? [])).toEqual(["files", "file:a.ts", "diff"]);
  });

  it("gives a file the place of the Files browser it was opened from", () => {
    const result = paneStripReplacement({
      previous: [diff, files, fileA, terminal],
      surfaces: [diff, fileA, terminal, fileB],
      opener: { kind: "pane", surfaceId: "files" },
    });
    expect(result?.index).toBe(1);
    expect(ids(result?.close ?? [])).toEqual(["file:a.ts"]);
    expect(ids(result?.ask ?? [])).toEqual(["terminal:1"]);
  });

  it.each([
    ["the opener is unknown", { previous: before, surfaces: [...before, fileB], opener: null }],
    [
      "the opener is the last pane",
      {
        previous: before,
        surfaces: [...before, fileB],
        opener: { kind: "pane", surfaceId: "browser:1" },
      },
    ],
    [
      "the opener has closed",
      {
        previous: before,
        surfaces: [...before, fileB],
        opener: { kind: "pane", surfaceId: "board" },
      },
    ],
    [
      "a placeholder became its real pane",
      {
        previous: [files, pane("browser:new", "preview")],
        surfaces: [files, browser],
        opener: { kind: "thread" },
      },
    ],
    ["a pane closed", { previous: before, surfaces: before.slice(1), opener: { kind: "thread" } }],
    [
      "another thread's panes showed",
      { previous: [diff], surfaces: [files, fileA], opener: { kind: "thread" } },
    ],
  ] as const)("leaves the panes alone when %s", (_name, input) => {
    expect(paneStripReplacement(input)).toBeNull();
  });
});

describe("paneStripOpenerFromEvent", () => {
  it("names the pressed column", () => {
    expect(paneStripOpenerFromEvent({ key: null, modified: false, column: "thread" })).toEqual({
      kind: "thread",
    });
    expect(paneStripOpenerFromEvent({ key: "Enter", modified: false, column: "files" })).toEqual({
      kind: "pane",
      surfaceId: "files",
    });
    expect(paneStripOpenerFromEvent({ key: null, modified: false, column: null })).toBeNull();
  });

  it("forgets the column on a shortcut and keeps it through typing", () => {
    expect(paneStripOpenerFromEvent({ key: "j", modified: true, column: "thread" })).toBeNull();
    expect(paneStripOpenerFromEvent({ key: "a", modified: false, column: "thread" })).toBe(
      undefined,
    );
  });
});
