import { describe, expect, it } from "vite-plus/test";

import { splitReLines, textAfterReLines } from "./replyMarkers.ts";

const reLine = (excerpt: string) => ({ text: `Re: "${excerpt}"`, excerpt });

describe("splitReLines", () => {
  it.each([
    {
      name: "a Re: line splits off with its excerpt",
      text: '**Re:** "fix the bubble"\n\nDone. The **bubble** opens it.',
      expected: { lines: [reLine("fix the bubble")], body: "Done. The **bubble** opens it." },
    },
    {
      name: "several Re: lines in a row read as one block",
      text: '  **Re:** "first words"  \r\n**Re:** "say "hi" back"\r\n \r\n\n- one\n\n**Re:** "later stays in the body"',
      expected: {
        lines: [reLine("first words"), reLine('say "hi" back')],
        body: '- one\n\n**Re:** "later stays in the body"',
      },
    },
    {
      name: "the body may follow without a blank line",
      text: '**Re:** "the script"\n    run it\n',
      expected: { lines: [reLine("the script")], body: "    run it\n" },
    },
    {
      name: "nothing after the Re: line yet",
      text: '**Re:** "done"\n\n  \n',
      expected: { lines: [reLine("done")], body: "" },
    },
    { name: "a plain Re:", text: "Re: foo\nBody", expected: null },
    { name: "a plain quoted Re:", text: 'Re: "foo"\nBody', expected: null },
    { name: "an italic Re:", text: '*Re:* "x"\nBody', expected: null },
    { name: "a bold line around the quote", text: '**Re: "x"**\nBody', expected: null },
    { name: "a quoted Re:", text: '> **Re:** "x"\nBody', expected: null },
    { name: "a listed Re:", text: '- **Re:** "x"\nBody', expected: null },
    { name: "no quote", text: "**Re:** fix it\nBody", expected: null },
    { name: "nothing after Re:", text: "**Re:**\nBody", expected: null },
    { name: "an empty quote", text: '**Re:** "  "\nBody', expected: null },
    { name: "an unclosed quote", text: '**Re:** "fix it\nBody', expected: null },
    { name: "a lone quote", text: '**Re:** "\nBody', expected: null },
    { name: "text after the closing quote", text: '**Re:** "fix" and more\nBody', expected: null },
    { name: "curly quotes", text: "**Re:** “fix”\nBody", expected: null },
    { name: "Re: later in the reply", text: 'Done.\n\n**Re:** "the rest"', expected: null },
    { name: "lowercase re:", text: '**re:** "it"\nBody', expected: null },
    {
      name: "an indented second line ends the block",
      text: '**Re:** "one"\n  **Re:** "two"',
      expected: { lines: [reLine("one")], body: '  **Re:** "two"' },
    },
  ])("$name", ({ text, expected }) => {
    expect(splitReLines(text)).toEqual(expected);
  });

  it.each([
    { text: '**Re:** "half a quo', lines: [{ text: 'Re: "half a quo', excerpt: null }] },
    { text: "**Re:**", lines: [{ text: "Re:", excerpt: null }] },
    {
      text: '**Re:** "one"\n**Re:** "tw',
      lines: [reLine("one"), { text: 'Re: "tw', excerpt: null }],
    },
    { text: "**Re", lines: null },
    { text: '**Re:** "one"\n\n**Re:** "tw', lines: [reLine("one")] },
  ])("while streaming, an unfinished last line counts: $text", ({ text, lines }) => {
    expect(splitReLines(text, true)?.lines ?? null).toEqual(lines);
    expect(splitReLines(text)?.lines.every((line) => line.excerpt !== null) ?? true).toBe(true);
  });

  it.each([
    { text: '**Re:** "fix it"\n\nDone. Fixed.', opening: "Done. Fixed." },
    { text: "Done. Fixed.", opening: "Done. Fixed." },
    { text: '**Re:** "only this"', opening: '**Re:** "only this"' },
  ])("a reply's opening skips Re: lines: $text", ({ text, opening }) => {
    expect(textAfterReLines(text)).toBe(opening);
  });
});
