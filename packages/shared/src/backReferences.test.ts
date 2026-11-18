import { describe, expect, it } from "vite-plus/test";

import { findBackReferences } from "./backReferences.ts";

describe("findBackReferences", () => {
  it.each([
    {
      name: "a marker in prose",
      text: 'I listed the risks earlier (↑ "the token expires after one hour").',
      expected: ["the token expires after one hour"],
    },
    {
      name: "curly quotes and no space after the arrow",
      text: "As said (↑“run the migration first”) and (↑ “keep the old table”).",
      expected: ["run the migration first", "keep the old table"],
    },
    {
      name: "mixed quote styles",
      text: '(↑ "deploy on friday”)',
      expected: ["deploy on friday"],
    },
    {
      name: "an unfinished marker while streaming",
      text: 'See above (↑ "the token expires after',
      expected: [],
    },
    {
      name: "a marker without its closing parenthesis",
      text: 'See above (↑ "the token expires" and more',
      expected: [],
    },
    {
      name: "an empty quote",
      text: 'See (↑ "  ")',
      expected: [],
    },
    {
      name: "a quote across lines",
      text: 'See (↑ "the token\nexpires")',
      expected: [],
    },
    { name: "an arrow alone", text: "Scroll ↑ to see it.", expected: [] },
  ])("$name", ({ text, expected }) => {
    expect(findBackReferences(text).map((reference) => reference.excerpt)).toEqual(expected);
  });

  it("reports where each marker sits", () => {
    const text = 'Done (↑ "the first words") now.';
    const [reference] = findBackReferences(text);
    expect(reference).toEqual({
      text: '(↑ "the first words")',
      excerpt: "the first words",
      start: 5,
      end: 26,
    });
    expect(text.slice(reference!.start, reference!.end)).toBe(reference!.text);
  });
});
