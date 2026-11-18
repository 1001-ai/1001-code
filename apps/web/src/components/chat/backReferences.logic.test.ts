import { describe, expect, it } from "vite-plus/test";

import {
  backReferenceSources,
  findBackReferenceTarget,
  findQuoteInSource,
  remarkBackReferences,
  renderedQuoteText,
  sameBackReferenceSources,
  type BackReferenceSource,
} from "./backReferences.logic";

const source = (itemId: string, text: string): BackReferenceSource => ({
  itemId,
  messageId: `message-${itemId}`,
  text,
});

describe("findQuoteInSource", () => {
  it.each([
    {
      name: "exact words",
      text: "Risks: the token expires after one hour, so refresh it.",
      excerpt: "the token expires after one hour",
      expected: "the token expires after one hour",
    },
    {
      name: "case, curly quotes and spacing differ",
      text: "Then we said “ship it   on Friday” and moved on.",
      excerpt: 'Said "ship it on friday"',
      expected: "said “ship it on Friday”",
    },
    {
      name: "markdown marks in the message",
      text: "- The **session token** expires after `3600` seconds.",
      excerpt: "session token expires after 3600",
      expected: "session token expires after 3600",
    },
    {
      name: "a line break inside the words",
      text: "The cache is\ncleared on deploy.",
      excerpt: "cache is cleared on deploy",
      expected: "cache is cleared on deploy",
    },
    {
      name: "underscores inside a name stay",
      text: "Set max_retries to five before launch.",
      excerpt: "set max_retries to five",
      expected: "Set max_retries to five",
    },
    {
      name: "words the message does not hold",
      text: "The token expires after one hour.",
      excerpt: "the token never expires",
      expected: null,
    },
  ])("$name", ({ text, excerpt, expected }) => {
    expect(findQuoteInSource(source("a", text), excerpt)).toBe(expected);
  });
});

describe("renderedQuoteText", () => {
  it("drops emphasis, code and line marks but keeps words", () => {
    expect(renderedQuoteText("## The *fast* path uses `run_all`\n> and __never__ waits")).toBe(
      "The fast path uses run_all and never waits",
    );
  });
});

describe("findBackReferenceTarget", () => {
  const sources = [
    source("1", "Please keep the old table until Friday."),
    source("2", "I will keep the old table until Friday and drop it after."),
    source("3", 'Done, as promised (↑ "keep the old table").'),
    source("4", "A later message says keep the old table too."),
  ];

  it("takes the newest earlier message that holds the words", () => {
    expect(findBackReferenceTarget(sources, "3", "keep the old table")).toEqual({
      messageId: "message-2",
      text: "keep the old table",
    });
    expect(findBackReferenceTarget(sources, "2", "keep the old table until")).toEqual({
      messageId: "message-1",
      text: "keep the old table until",
    });
  });

  it("never points at the marker's own message or a later one", () => {
    expect(findBackReferenceTarget(sources, "3", "as promised")).toBeNull();
    expect(findBackReferenceTarget(sources, "3", "A later message says")).toBeNull();
    expect(findBackReferenceTarget(sources, "1", "keep the old table")).toBeNull();
    expect(findBackReferenceTarget(sources, "unknown", "keep the old table")).toBeNull();
  });
});

describe("backReferenceSources", () => {
  it("keeps finished messages, without a reply's Re: lines, and reuses them per item", () => {
    const user = { item: { id: "1", type: "user_message", text: "hi there", messageId: "u1" } };
    const reply = {
      item: {
        id: "2",
        type: "assistant_message",
        text: '**Re:** "hi there friend"\n\nHello back.',
        messageId: "a1",
      },
    };
    const streaming = {
      item: { id: "3", type: "assistant_message", text: "Still", messageId: "a2", streaming: true },
    };
    const work = { item: { id: "4", type: "command_execution" } };
    const first = backReferenceSources([user, reply, streaming, work]);
    expect(first).toEqual([
      { itemId: "1", messageId: "u1", text: "hi there" },
      { itemId: "2", messageId: "a1", text: "Hello back." },
    ]);
    expect(sameBackReferenceSources(first, backReferenceSources([user, reply, streaming]))).toBe(
      true,
    );
    const finished = { item: { ...streaming.item, streaming: false } };
    expect(sameBackReferenceSources(first, backReferenceSources([user, reply, finished]))).toBe(
      false,
    );
  });
});

describe("remarkBackReferences", () => {
  it("links complete markers in prose and leaves code and links alone", () => {
    const tree = {
      type: "root" as const,
      children: [
        {
          type: "paragraph" as const,
          children: [
            { type: "text" as const, value: 'As listed (↑ "the token expires") and (↑ "half' },
            { type: "inlineCode" as const, value: '(↑ "in code")' },
          ],
        },
      ],
    };
    remarkBackReferences()(tree);
    expect(tree.children[0]!.children).toEqual([
      { type: "text", value: "As listed " },
      {
        type: "link",
        url: "t3-context://v1/back-reference/ref",
        children: [{ type: "text", value: '(↑ "the token expires")' }],
      },
      { type: "text", value: ' and (↑ "half' },
      { type: "inlineCode", value: '(↑ "in code")' },
    ]);
  });
});
