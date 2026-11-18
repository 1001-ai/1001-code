import { describe, expect, it } from "@effect/vitest";

import { attributeLines, parseBlamePorcelain } from "./teamCatalogBlame.ts";

const ADA = "a".repeat(40);

const entry = (commit: string, line: number, content: string, extra: ReadonlyArray<string> = []) =>
  [
    `${commit} ${line} ${line} 1`,
    "author Ada Lovelace",
    "author-mail <ada@acme.test>",
    "author-time 1772445600",
    "author-tz +0100",
    "summary Remember for the team: Use `vp test` (#14)",
    ...extra,
    "filename memory/team.md",
    `\t${content}`,
  ].join("\n");

describe("parseBlamePorcelain", () => {
  it("attributes committed lines and leaves uncommitted and boundary lines unknown", () => {
    const output = [
      entry(ADA, 1, "- Use `vp test`."),
      entry("0".repeat(40), 2, "- Not committed yet."),
      entry("b".repeat(40), 3, "- Older than the history.", ["boundary"]),
      "",
    ].join("\n");
    expect(parseBlamePorcelain(output)).toEqual([
      {
        text: "- Use `vp test`.",
        author: "Ada Lovelace",
        authoredAt: "2026-03-02T10:00:00.000Z",
        commit: ADA,
        pullRequest: 14,
      },
      {
        text: "- Not committed yet.",
        author: null,
        authoredAt: null,
        commit: null,
        pullRequest: null,
      },
      {
        text: "- Older than the history.",
        author: null,
        authoredAt: null,
        commit: null,
        pullRequest: null,
      },
    ]);
  });
});

describe("attributeLines", () => {
  const blame = parseBlamePorcelain([entry(ADA, 1, "- One."), entry(ADA, 2, "- Two.")].join("\n"));

  it("pairs each line with its blame", () => {
    expect(attributeLines("- One.\n- Two.\n", blame).map((line) => line.author)).toEqual([
      "Ada Lovelace",
      "Ada Lovelace",
    ]);
  });

  it("leaves every line unknown when the blame is of another version or missing", () => {
    for (const lines of [
      attributeLines("- One.\n- Changed.\n", blame),
      attributeLines("- One.\n", blame),
      attributeLines("- One.\n- Two.\n", null),
    ]) {
      expect(lines.every((line) => line.author === null && line.commit === null)).toBe(true);
    }
    expect(attributeLines("", blame)).toEqual([]);
  });
});
