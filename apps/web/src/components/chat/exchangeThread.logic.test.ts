import {
  EnvironmentId,
  MessageId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationMessageContext,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { responseContextRecord } from "~/lib/composerContextRecords";
import {
  deriveExchangeMap,
  replyMarkersEnabled,
  sameExchangeStructure,
  setReplyMarkersEnabled,
  shouldAttachThreadReply,
  threadTriggerFocusSelectors,
  canRestoreFocusTo,
  threadExchangeKeys,
  threadLatestReplyRowId,
  threadRowIds,
  threadSummaryLabel,
  type ExchangeRow,
} from "./exchangeThread.logic";

const user = (id: string, runId: string | null, context?: OrchestrationMessageContext) => ({
  id,
  kind: "message",
  message: {
    id: MessageId.make(id),
    role: "user" as const,
    runId: runId === null ? null : RunId.make(runId),
    ...(context ? { context } : {}),
  },
});
const reply = (id: string, runId: string | null) => ({
  id,
  kind: "message",
  message: {
    id: MessageId.make(id),
    role: "assistant" as const,
    runId: runId === null ? null : RunId.make(runId),
  },
});
const work = (id: string) => ({ id, kind: "turn-fold" });
const replyingTo = (messageId: string): OrchestrationMessageContext => ({
  version: 1,
  records: [
    responseContextRecord({
      citation: {
        version: 1,
        environmentId: EnvironmentId.make("env"),
        threadId: ThreadId.make("thread"),
        messageId: MessageId.make(messageId),
        text: "Done",
        start: 0,
        end: 4,
        prefix: "",
        suffix: "",
      },
      itemId: TurnItemId.make(`item:${messageId}`),
      subagents: [],
    }),
  ],
});

/** What each exchange shows: its reply row, and the user rows that row does not sit under. */
const markers = (rows: ReadonlyArray<ExchangeRow>) =>
  [...deriveExchangeMap(rows).exchanges.values()].map((exchange) => ({
    key: exchange.key,
    users: exchange.userRowIds,
    reply: exchange.replyRowId,
    earlier: exchange.earlierRowIds,
  }));

describe("deriveExchangeMap", () => {
  it.each([
    {
      name: "consecutive exchanges read in order",
      rows: [user("a", "r1"), work("f1"), reply("ra", "r1"), user("b", "r2"), reply("rb", "r2")],
      expected: [
        { key: "r1", users: ["a"], reply: "ra", earlier: [] },
        { key: "r2", users: ["b"], reply: "rb", earlier: [] },
      ],
    },
    {
      name: "queued messages answered together sit back to back above their reply",
      rows: [user("a", "r1"), user("b", "r1"), work("f1"), reply("ra", "r1")],
      expected: [{ key: "r1", users: ["a", "b"], reply: "ra", earlier: [] }],
    },
    {
      name: "a steer after the run's work leaves the first message above the split",
      rows: [user("a", "r1"), work("f1"), user("b", "r1"), work("f2"), reply("ra", "r1")],
      expected: [{ key: "r1", users: ["a", "b"], reply: "ra", earlier: ["a"] }],
    },
    {
      name: "a steer while the run is still talking answers from its next message",
      rows: [user("a", "r1"), reply("c1", "r1"), user("b", "r1"), reply("ra", "r1")],
      expected: [{ key: "r1", users: ["a", "b"], reply: "ra", earlier: ["a"] }],
    },
    {
      name: "interleaved sends mark both replies",
      rows: [user("a", "r1"), user("b", "r2"), reply("ra", "r1"), reply("rb", "r2")],
      expected: [
        { key: "r1", users: ["a"], reply: "ra", earlier: ["a"] },
        { key: "r2", users: ["b"], reply: "rb", earlier: ["b"] },
      ],
    },
    {
      name: "a reply with no user message, like a scheduled wake-up, is no exchange to mark",
      rows: [user("a", "r1"), reply("ra", "r1"), work("wake"), reply("rs", "r2")],
      expected: [
        { key: "r1", users: ["a"], reply: "ra", earlier: [] },
        { key: "r2", users: [], reply: null, earlier: [] },
      ],
    },
    {
      name: "a message still waiting for its reply has nothing to mark",
      rows: [user("a", "r1"), reply("ra", "r1"), user("b", null)],
      expected: [
        { key: "r1", users: ["a"], reply: "ra", earlier: [] },
        { key: "message:b", users: ["b"], reply: null, earlier: [] },
      ],
    },
    {
      name: "runless imported turns pair each reply with the message before it",
      rows: [user("a", null), reply("ra", null), user("b", null), reply("rb", null)],
      expected: [
        { key: "message:a", users: ["a"], reply: "ra", earlier: [] },
        { key: "message:b", users: ["b"], reply: "rb", earlier: [] },
      ],
    },
  ])("$name", ({ rows, expected }) => {
    expect(markers(rows)).toEqual(expected);
  });
});

describe("thread view", () => {
  const rows = [
    user("a", "r1"),
    work("f1"),
    user("b", "r1"),
    reply("ra", "r1"),
    { id: "meta:ra", kind: "assistant-meta", message: reply("ra", "r1").message },
    user("c", "r2"),
    reply("rc", "r2"),
    user("d", "r3", replyingTo("ra")),
    reply("rd", "r3"),
    user("e", "r4", replyingTo("rd")),
  ];
  const map = deriveExchangeMap(rows);

  it("follows reply citations both ways, so any exchange opens the whole thread", () => {
    expect(threadExchangeKeys(map, "r1")).toEqual(["r1", "r3", "r4"]);
    expect(threadExchangeKeys(map, "r3")).toEqual(["r1", "r3", "r4"]);
    expect(threadExchangeKeys(map, "r2")).toEqual(["r2"]);
    expect(threadExchangeKeys(map, "gone")).toEqual([]);
  });

  it("shows only the thread's messages, replies and their meta rows", () => {
    const keys = threadExchangeKeys(map, "r1");
    expect([...threadRowIds(map, keys)].toSorted()).toEqual(
      ["a", "b", "ra", "meta:ra", "d", "rd", "e"].toSorted(),
    );
    expect(threadSummaryLabel(map, keys)).toBe("4 messages, 2 replies");
    expect(threadSummaryLabel(map, ["r2"])).toBe("1 message, 1 reply");
    expect(threadLatestReplyRowId(map, keys)).toBe("rd");
  });
});

describe("shouldAttachThreadReply", () => {
  it.each([
    {
      name: "opening over the user's own reply replaces it",
      input: { candidateId: "r1", attachedId: null, draftReplyId: "mine", replacesDraft: true },
      attach: true,
    },
    {
      name: "a first attach the composer refused is tried again once it is free",
      input: { candidateId: "r1", attachedId: null, draftReplyId: null, replacesDraft: true },
      attach: true,
    },
    {
      name: "a send consumed the reply, so the newest reply attaches",
      input: { candidateId: "r2", attachedId: "r1", draftReplyId: null, replacesDraft: false },
      attach: true,
    },
    {
      name: "the view's own reply moves on to the newest reply",
      input: { candidateId: "r2", attachedId: "r1", draftReplyId: "r1", replacesDraft: false },
      attach: true,
    },
    {
      name: "a reply the user picked after opening stays",
      input: { candidateId: "r2", attachedId: "r1", draftReplyId: "mine", replacesDraft: false },
      attach: false,
    },
    {
      name: "the composer already replies to the newest reply",
      input: { candidateId: "r1", attachedId: "r1", draftReplyId: "r1", replacesDraft: false },
      attach: false,
    },
    {
      name: "a thread whose reply has not settled has nothing to attach",
      input: { candidateId: null, attachedId: null, draftReplyId: null, replacesDraft: true },
      attach: false,
    },
  ])("$name", ({ input, attach }) => {
    expect(shouldAttachThreadReply(input)).toBe(attach);
  });
});

describe("threadTriggerFocusSelectors", () => {
  it("finds the control that opened the view by its row, then the row, quoting odd ids", () => {
    expect(threadTriggerFocusSelectors({ rowId: 'message:a"b\\c', control: "reply-link" })).toEqual(
      [
        '[data-exchange-thread-control="reply-link"][data-exchange-control-row="message:a\\"b\\\\c"]',
        '[data-timeline-row-id="message:a\\"b\\\\c"]',
      ],
    );
  });
});

describe("canRestoreFocusTo", () => {
  const shown = { connected: true, shut: false, visibility: "visible", width: 24, height: 24 };
  it.each([
    { name: "a shown control", candidate: shown, focusable: true },
    { name: "a removed node", candidate: { ...shown, connected: false }, focusable: false },
    {
      name: "the collapsed copy of the actions",
      candidate: { ...shown, width: 0, height: 0 },
      focusable: false,
    },
    {
      name: "a control in the faded list",
      candidate: { ...shown, visibility: "hidden" },
      focusable: false,
    },
    {
      name: "a control in an inert or aria-hidden subtree",
      candidate: { ...shown, shut: true },
      focusable: false,
    },
  ])("$name", ({ candidate, focusable }) => {
    expect(canRestoreFocusTo(candidate)).toBe(focusable);
  });
});

describe("sameExchangeStructure", () => {
  it("ignores streamed text but sees new rows, runs and citations", () => {
    const rows = [user("a", "r1"), reply("ra", "r1")];
    const streamed = [rows[0]!, { ...rows[1]!, message: { ...rows[1]!.message } }];
    expect(sameExchangeStructure(rows, streamed)).toBe(true);
    expect(sameExchangeStructure(rows, [...rows, work("f")])).toBe(false);
    expect(sameExchangeStructure(rows, [user("a", "r2"), rows[1]!])).toBe(false);
    expect(sameExchangeStructure(rows, [user("a", "r1", replyingTo("x")), rows[1]!])).toBe(false);
  });
});

describe("reply markers setting", () => {
  it("is on by default and stores only the change", () => {
    expect(replyMarkersEnabled({ threadDetailsItems: {} })).toBe(true);
    const off = setReplyMarkersEnabled({ threadDetailsItems: { usage: true } }, false);
    expect(off).toEqual({ usage: true, replyMarkers: false });
    expect(replyMarkersEnabled({ threadDetailsItems: off })).toBe(false);
    expect(setReplyMarkersEnabled({ threadDetailsItems: off }, true)).toEqual({ usage: true });
  });
});
