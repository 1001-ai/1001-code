import { describe, expect, it } from "vite-plus/test";

import {
  findBackReferences,
  findQuotedMessage,
  markdownDisplayText,
  matchQuote,
  quoteWords,
} from "./backReferences.ts";

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

describe("matchQuote", () => {
  const found = (text: string, quote: string) => {
    const match = matchQuote(text, quote);
    return match === null ? null : { kind: match.kind, text: text.slice(match.start, match.end) };
  };

  it.each([
    {
      name: "exact words",
      text: "Risks: the token expires after one hour, so refresh it.",
      quote: "the token expires after one hour",
      expected: { kind: "exact", text: "the token expires after one hour" },
    },
    {
      name: "case, quote style, dashes, ellipses and punctuation differ",
      text: "Then we said “don’t ship—wait…” and moved on.",
      quote: 'We said "DON\'T ship - wait..."',
      expected: { kind: "exact", text: "we said “don’t ship—wait" },
    },
    {
      name: "spacing and line breaks differ",
      text: "The cache is\n   cleared on deploy.",
      quote: "cache is cleared on deploy",
      expected: { kind: "exact", text: "cache is\n   cleared on deploy" },
    },
    {
      name: "underscores inside a name stay part of it",
      text: "Set max_retries to five; max retries alone is wrong.",
      quote: "max_retries to five",
      expected: { kind: "exact", text: "max_retries to five" },
    },
    {
      name: "the first of two occurrences",
      text: "Keep the old table. Later: keep the old table.",
      quote: "keep the old table",
      expected: { kind: "exact", text: "Keep the old table" },
    },
    {
      name: "a close match: one word changed",
      text: "The session token expires after one hour, so long uploads fail.",
      quote: "the session token expires after an hour",
      expected: { kind: "close", text: "The session token expires after one hour" },
    },
    {
      name: "a close match: one word left out",
      text: "We cannot change db/schema.sql until the release freeze ends.",
      quote: "cannot change the schema until the freeze ends",
      expected: {
        kind: "close",
        text: "cannot change db/schema.sql until the release freeze ends",
      },
    },
    {
      name: "a close match starts at the first word it uses",
      text: "It expires after one hour, so an upload that runs longer than an hour fails.",
      quote: "upload that runs longer than one hour",
      expected: { kind: "close", text: "upload that runs longer than an hour" },
    },
    {
      name: "a weak match: too few words in order",
      text: "The session token expires after one hour, so long uploads fail.",
      quote: "the token runs out after an hour",
      expected: null,
    },
    {
      name: "a weak match: the words spread too far apart",
      text: "the cache is old and the deploy runs late and nobody has cleared the cache on deploy",
      quote: "the cache cleared on deploy day",
      expected: null,
    },
    {
      name: "a short quote never matches closely",
      text: "The token expires after one hour.",
      quote: "token lasts",
      expected: null,
    },
    {
      name: "Han characters count one by one",
      text: "我们明天发布新版本。",
      quote: "明天发布",
      expected: { kind: "exact", text: "明天发布" },
    },
  ])("$name", ({ text, quote, expected }) => {
    expect(found(text, quote)).toEqual(expected);
  });

  it("finds no close match when asked for exact words only", () => {
    expect(
      matchQuote(
        "The session token expires after one hour.",
        "session token expires after an hour",
        "exact",
      ),
    ).toBeNull();
  });
});

describe("findQuotedMessage", () => {
  const messages = [
    "Please keep the old table until Friday.",
    "I will keep the old table until Friday and drop it after.",
    "Unrelated: deploys run at noon.",
  ];
  const find = (quote: string) => findQuotedMessage(messages, quoteWords, quote)?.message ?? null;

  it("takes the newest message that holds the words", () => {
    expect(find("keep the old table until friday")).toBe(messages[1]);
  });

  it("takes an exact match in an older message over a close one in a newer message", () => {
    expect(find("please keep the old table")).toBe(messages[0]);
  });

  it("falls back to the newest close match", () => {
    expect(find("we keep the old table until friday")).toBe(messages[1]);
    expect(find("the token never expires")).toBeNull();
  });
});

describe("markdownDisplayText", () => {
  it("drops link targets, list numbers, task boxes, fences and tags", () => {
    const shown = markdownDisplayText(
      [
        "1. See [the setup guide](https://acme.test/docs/setup) first.",
        "- [x] **Done** with <kbd>Ctrl</kbd>",
        "```ts",
        "run_all()",
        "```",
        "[ref]: https://acme.test/ref",
      ].join("\n"),
    );
    expect(quoteWords(shown).map((word) => word.value)).toEqual([
      "see",
      "the",
      "setup",
      "guide",
      "first",
      "done",
      "with",
      "ctrl",
      "run_all",
    ]);
  });
});
