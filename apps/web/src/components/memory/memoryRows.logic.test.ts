import type { MemoryLine } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  changeCount,
  editRow,
  inlineCodeParts,
  memoryFileText,
  memoryRows,
  NO_EDITS,
  pullRequestUrl,
  removeRow,
  restoreRow,
  setAdded,
} from "./memoryRows.logic";

const line = (text: string): MemoryLine => ({
  text,
  author: "Ada Lovelace",
  authoredAt: "2026-03-02T10:00:00.000Z",
  commit: "a".repeat(40),
  pullRequest: 14,
});

const FILE = [
  "# Team memory",
  "",
  "- Prefer small pull requests.",
  "- Run `vp test` before pushing.",
  "",
  "## How we build",
  "  * Nested with a star.",
  "A plain line.",
].map(line);

describe("memoryRows", () => {
  it("makes headings section titles, list items and plain lines rows, and skips blank lines", () => {
    expect(
      memoryRows(FILE).map((row) =>
        row.kind === "heading" ? [row.index, "#", row.text] : [row.index, row.marker, row.text],
      ),
    ).toEqual([
      [0, "#", "Team memory"],
      [2, "- ", "Prefer small pull requests."],
      [3, "- ", "Run `vp test` before pushing."],
      [5, "#", "How we build"],
      [6, "  * ", "Nested with a star."],
      [7, "", "A plain line."],
    ]);
  });
});

describe("memoryFileText", () => {
  it("returns the file unchanged without edits", () => {
    expect(memoryFileText(FILE, NO_EDITS)).toBe(`${FILE.map((entry) => entry.text).join("\n")}\n`);
  });

  it("applies edits, removals and additions, keeping headings, blank lines, markers and order", () => {
    const rows = memoryRows(FILE);
    const second = rows[2]!;
    const nested = rows[4]!;
    let edits = editRow(NO_EDITS, second, "Run `vp test run`\nbefore pushing.");
    edits = editRow(edits, nested, "Nested, edited.");
    edits = removeRow(edits, 7);
    edits = setAdded(edits, 0, "Keep replies short.");
    expect(changeCount(edits)).toBe(4);
    expect(memoryFileText(FILE, edits)).toBe(
      [
        "# Team memory",
        "",
        "- Prefer small pull requests.",
        "- Run `vp test run` before pushing.",
        "",
        "## How we build",
        "  * Nested, edited.",
        "- Keep replies short.",
        "",
      ].join("\n"),
    );
  });

  it("drops an edit back to the original, removes a row edited to nothing, and undoes", () => {
    const row = memoryRows(FILE)[1]!;
    const edited = editRow(NO_EDITS, row, "Prefer tiny pull requests.");
    expect(editRow(edited, row, " Prefer small pull requests. ")).toEqual(NO_EDITS);
    const emptied = editRow(edited, row, "  ");
    expect(emptied).toEqual({ edited: {}, removed: [2], added: [] });
    expect(changeCount(emptied)).toBe(1);
    expect(restoreRow(emptied, 2)).toEqual(NO_EDITS);
    expect(setAdded(setAdded(NO_EDITS, 0, "New one."), 0, "")).toEqual(NO_EDITS);
  });

  it("adds after the last line, not after trailing blank lines, and starts an empty file", () => {
    const withBlank = [line("- One."), line("")];
    expect(memoryFileText(withBlank, setAdded(NO_EDITS, 0, "Two."))).toBe("- One.\n- Two.\n");
    expect(memoryFileText([], setAdded(NO_EDITS, 0, "First."))).toBe("- First.\n");
    expect(memoryFileText([line("- Only.")], removeRow(NO_EDITS, 0))).toBe("");
  });
});

describe("inlineCodeParts", () => {
  it("splits out code spans", () => {
    expect(inlineCodeParts("Run `vp test` first, not ``.")).toEqual([
      { code: false, text: "Run " },
      { code: true, text: "vp test" },
      { code: false, text: " first, not ``." },
    ]);
  });
});

describe("pullRequestUrl", () => {
  it("builds the hosted page and gives up on a local catalog", () => {
    expect(pullRequestUrl("git@github.com:acme/home.git", 14)).toBe(
      "https://github.com/acme/home/pull/14",
    );
    expect(pullRequestUrl("https://GitHub.com/acme/home", 3)).toBe(
      "https://github.com/acme/home/pull/3",
    );
    expect(pullRequestUrl("/srv/catalog", 3)).toBeNull();
    expect(pullRequestUrl(null, 3)).toBeNull();
  });
});
