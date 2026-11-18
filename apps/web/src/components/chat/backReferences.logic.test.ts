import { ComposerContextId, GuestMessageId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  backReferenceSources,
  findBackReferenceTarget,
  remarkBackReferences,
  sameBackReferenceSources,
  searchBackReferenceHistory,
  type BackReferenceSource,
} from "./backReferences.logic";

const source = (itemId: string, text: string): BackReferenceSource => ({
  itemId,
  messageId: `message-${itemId}`,
  text,
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
      kind: "exact",
    });
    expect(findBackReferenceTarget(sources, "2", "keep the old table until")).toEqual({
      messageId: "message-1",
      kind: "exact",
    });
  });

  it("never points at the marker's own message or a later one", () => {
    expect(findBackReferenceTarget(sources, "3", "as promised")).toBeNull();
    expect(findBackReferenceTarget(sources, "3", "A later message says")).toBeNull();
    expect(findBackReferenceTarget(sources, "1", "keep the old table")).toBeNull();
    expect(findBackReferenceTarget(sources, "unknown", "keep the old table")).toBeNull();
  });

  it.each([
    {
      name: "bold and inline code",
      text: "- The **session token** expires after `3600` seconds.",
      excerpt: "session token expires after 3600",
    },
    {
      name: "a link, by its text and not its target",
      text: "Read [the setup guide](https://acme.test/docs) before you deploy.",
      excerpt: "read the setup guide before you",
    },
    {
      name: "italics across a line break",
      text: "The cache is _cleared_\non deploy.",
      excerpt: "cache is cleared on deploy",
    },
  ])("matches the shown words across $name", ({ text, excerpt }) => {
    const shown = [source("1", text), source("2", "reply")];
    expect(findBackReferenceTarget(shown, "2", excerpt)).toEqual({
      messageId: "message-1",
      kind: "exact",
    });
  });

  it("takes a close match only when no earlier message holds the words exactly", () => {
    const closeOnly = [
      source("1", "The session token expires after one hour."),
      source("2", "reply"),
    ];
    expect(
      findBackReferenceTarget(closeOnly, "2", "the session token expires after an hour"),
    ).toEqual({ messageId: "message-1", kind: "close" });
    const both = [source("1", "The session token expires after an hour."), ...closeOnly].map(
      (entry, index) => ({ ...entry, itemId: String(index), messageId: `m${index}` }),
    );
    expect(findBackReferenceTarget(both, "2", "the session token expires after an hour")).toEqual({
      messageId: "m0",
      kind: "exact",
    });
  });
});

describe("searchBackReferenceHistory", () => {
  const search = (pages: ReadonlyArray<boolean>, loads: Array<string> = []) => {
    let loaded = 0;
    return searchBackReferenceHistory({
      find: () => (pages[loaded] ? { messageId: `page-${loaded}`, kind: "exact" as const } : null),
      readHistory: async () => ({ hasMoreHistory: loaded < pages.length - 1 }),
      loadPage: async () => {
        loads.push("page");
        loaded += 1;
        return { _tag: "loaded" };
      },
    });
  };

  it("pages older history in until a message holds the words", async () => {
    const loads: Array<string> = [];
    await expect(search([false, false, true], loads)).resolves.toEqual({
      _tag: "found",
      target: { messageId: "page-2", kind: "exact" },
    });
    expect(loads).toHaveLength(2);
  });

  it("loads nothing when a loaded message holds the words, and gives up at the start", async () => {
    const loads: Array<string> = [];
    await expect(search([true], loads)).resolves.toMatchObject({ _tag: "found" });
    await expect(search([false, false], loads)).resolves.toEqual({ _tag: "not-found" });
    expect(loads).toHaveLength(1);
  });

  it("stops when a page fails to load", async () => {
    await expect(
      searchBackReferenceHistory({
        find: () => null,
        readHistory: async () => ({ hasMoreHistory: true }),
        loadPage: async () => ({ _tag: "error" }),
      }),
    ).resolves.toEqual({ _tag: "not-found" });
  });
});

describe("backReferenceSources", () => {
  it("keeps finished messages as their rows show them, without a reply's Re: lines, a Re:-only reply, automation prompts, flagged workflow openings or file-only messages, and reuses them per item", () => {
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
    const reOnly = {
      item: { id: "5", type: "assistant_message", text: '**Re:** "hi there"', messageId: "a3" },
    };
    const automation = {
      item: {
        id: "6",
        type: "user_message",
        text: "hi there",
        messageId: "u2",
        scheduledTaskId: "t",
      },
    };
    const workflow = {
      item: {
        id: "7",
        type: "user_message",
        text: "hi there",
        messageId: "u3",
        workflowScript: true,
      },
    };
    const legacyAutomation = {
      item: {
        id: "8",
        type: "user_message",
        text: "[Triggered by schedule task: Daily]\n\nhi there",
        messageId: "scheduled-task-message:task:1:scheduled",
      },
    };
    const userCode = {
      item: {
        id: "9",
        type: "user_message",
        text: 'export const meta = { name: "hi there" };',
        messageId: "u4",
      },
    };
    const guest = {
      item: {
        id: "10",
        type: "user_message",
        text: "Sam, a guest, wrote: hi there",
        messageId: "u5",
        context: {
          version: 1 as const,
          records: [],
          guest: { guestMessageId: GuestMessageId.make("g1"), name: "Sam", text: "hello from Sam" },
        },
      },
    };
    const file = {
      type: "file" as const,
      id: "report",
      name: "report.pdf",
      mimeType: "application/pdf",
      sizeBytes: 1024,
    };
    const fileOnly = {
      item: {
        id: "11",
        type: "user_message",
        text: "[report.pdf](t3-context://v1/file/report)",
        messageId: "u6",
        attachments: [file],
        context: {
          version: 1 as const,
          records: [
            {
              version: 1,
              kind: "file",
              contextId: ComposerContextId.make("report"),
              label: file.name,
              attachmentId: file.id,
              type: file.type,
              name: file.name,
              mimeType: file.mimeType,
              sizeBytes: file.sizeBytes,
            },
          ],
        },
      },
    };
    const first = backReferenceSources([
      user,
      reply,
      streaming,
      work,
      reOnly,
      automation,
      workflow,
      legacyAutomation,
      userCode,
      guest,
      fileOnly,
    ]);
    expect(first).toEqual([
      { itemId: "1", messageId: "u1", text: "hi there" },
      { itemId: "2", messageId: "a1", text: "Hello back." },
      { itemId: "9", messageId: "u4", text: 'export const meta = { name: "hi there" };' },
      { itemId: "10", messageId: "u5", text: "hello from Sam" },
    ]);
    expect(
      sameBackReferenceSources(
        first,
        backReferenceSources([user, reply, streaming, userCode, guest]),
      ),
    ).toBe(true);
    const finished = { item: { ...streaming.item, streaming: false } };
    expect(
      sameBackReferenceSources(
        first,
        backReferenceSources([user, reply, finished, userCode, guest]),
      ),
    ).toBe(false);
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
