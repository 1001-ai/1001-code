import { MessageId, NodeId, RunAttemptId, RunId } from "@t3tools/contracts";
import { QUESTION_SKIPPED_ANSWER } from "@t3tools/shared/questionCards";
import * as DateTime from "effect/DateTime";
import type { Element } from "hast";
import { describe, expect, it } from "vite-plus/test";

import { wordsHast } from "~/markdown/wordsHast";
import type { TimelineEntry } from "../../session-logic";
import {
  deriveMessagesTimelineRows,
  timelineTurnFoldRunIdsByEntryId,
} from "./MessagesTimeline.logic";
import {
  findQuestionAnswer,
  findQuestionRefs,
  hastQuestionRefs,
  isQuestionWithdrawn,
  latestQuestionCards,
  selectedMultiOptions,
  toggleMultiOption,
  writeAnswerLine,
} from "./questionBlock.logic";

describe("writeAnswerLine", () => {
  it.each([
    ["an empty draft", "", "Q1", "Yes", "Q1: Yes"],
    ["a draft with text", "Thanks.", "Q1", "Yes", "Thanks.\nQ1: Yes"],
    ["a draft ending in a newline", "Thanks.\n", "Q1", "Yes", "Thanks.\nQ1: Yes"],
    ["its own line", "Intro\nQ1: No\nQ2: A", "Q1", "Yes", "Intro\nQ1: Yes\nQ2: A"],
    ["a line with spacing", "  Q1 :  No", "Q1", "Yes", "Q1: Yes"],
    ["only that id", "Q10: x", "Q1", "y", "Q10: x\nQ1: y"],
    ["a removal", "Intro\nQ1: No\nQ2: A", "Q1", null, "Intro\nQ2: A"],
    ["a removal of nothing", "Intro", "Q1", null, "Intro"],
    ["a blank answer", "Q1: No", "Q1", "  ", ""],
  ])("handles %s", (_label, prompt, id, answer, expected) => {
    expect(writeAnswerLine(prompt, id, answer)).toBe(expected);
  });
});

describe("multi answers", () => {
  const options = ["Web", "Desktop", "Mobile"];

  it("toggles options in their listed order", () => {
    const one = toggleMultiOption(options, null, "Mobile");
    const two = toggleMultiOption(options, one, "Web");
    expect(two).toBe("Web, Mobile");
    expect([...selectedMultiOptions(options, two)]).toEqual(["Web", "Mobile"]);
    expect(toggleMultiOption(options, toggleMultiOption(options, two, "Web"), "Mobile")).toBeNull();
  });

  it("selects nothing from a typed or skipped answer, and a pick replaces it", () => {
    expect(selectedMultiOptions(options, "Whatever works").size).toBe(0);
    expect(selectedMultiOptions(options, QUESTION_SKIPPED_ANSWER).size).toBe(0);
    expect(toggleMultiOption(options, QUESTION_SKIPPED_ANSWER, "Desktop")).toBe("Desktop");
  });
});

describe("findQuestionAnswer", () => {
  const user = (id: string, text: string) => ({
    item: { id, type: "user_message", text, messageId: `m-${id}` },
  });
  const assistant = (id: string) => ({ item: { id, type: "assistant_message" } });

  it("reads the answer from a later user message", () => {
    const items = [assistant("a1"), user("u1", "Q1: Yes")];
    expect(findQuestionAnswer(items, "a1", "Q1")).toEqual({ answer: "Yes", messageId: "m-u1" });
  });

  it("ignores answers from before the question", () => {
    const items = [user("u0", "Q1: Old"), assistant("a1"), user("u1", "Thanks")];
    expect(findQuestionAnswer(items, "a1", "Q1")).toBeNull();
  });

  it("takes the latest answering message, even with the same answer", () => {
    const items = [assistant("a1"), user("u1", "Q1: Yes"), assistant("a2"), user("u2", "Q1: Yes")];
    expect(findQuestionAnswer(items, "a1", "Q1")).toEqual({ answer: "Yes", messageId: "m-u2" });
    expect(findQuestionAnswer([...items, user("u3", "Q1: No")], "a2", "Q1")).toEqual({
      answer: "No",
      messageId: "m-u3",
    });
    expect(findQuestionAnswer([...items, user("u3", "Thanks")], "a1", "Q1")).toEqual({
      answer: "Yes",
      messageId: "m-u2",
    });
  });

  it("ignores lines in assistant messages and unknown items", () => {
    const items = [
      assistant("a1"),
      { item: { id: "a2", type: "assistant_message", text: "Q1: Yes" } },
      user("u1", "Q2: B"),
    ];
    expect(findQuestionAnswer(items, "a1", "Q1")).toBeNull();
    expect(findQuestionAnswer(items, "missing", "Q2")).toBeNull();
  });

  it("reads an answer still queued, newest first, over the timeline's", () => {
    const queued = (id: string, text: string) => ({ text, messageId: `m-${id}` });
    const items = [assistant("a1"), user("u1", "Q1: Yes")];
    expect(findQuestionAnswer([assistant("a1")], "a1", "Q1", [queued("q1", "Q1: Yes")])).toEqual({
      answer: "Yes",
      messageId: "m-q1",
    });
    expect(
      findQuestionAnswer(items, "a1", "Q1", [
        queued("q1", "Q1: No"),
        queued("q2", "Q1: Maybe"),
        queued("q3", "Queued message"),
      ]),
    ).toEqual({ answer: "Maybe", messageId: "m-q2" });
    expect(findQuestionAnswer(items, "a1", "Q1", [queued("q1", "Thanks")])).toEqual({
      answer: "Yes",
      messageId: "m-u1",
    });
    expect(findQuestionAnswer(items, "missing", "Q1", [queued("q1", "Q1: No")])).toBeNull();
  });
});

describe("isQuestionWithdrawn", () => {
  const card = (id: string) => `> **${id} · Ship it?**\n>\n> - Yes\n> - No`;
  const assistant = (id: string, text: string, streaming = false) => ({
    item: { id, type: "assistant_message", text, messageId: `m-${id}`, streaming },
  });
  const user = (id: string, text: string) => ({
    item: { id, type: "user_message", text, messageId: `m-${id}` },
  });
  const asked = assistant("a1", `${card("Q1")}\n\n${card("Q2")}`);

  it("applies to a card of the latest message that asks cards", () => {
    const items = [asked, user("u1", "CSV only"), assistant("a2", "Q2: no longer needed")];
    expect(isQuestionWithdrawn(items, "a1", "Q2")).toBe(true);
    expect(isQuestionWithdrawn(items, "a1", "Q1")).toBe(false);
  });

  it("applies when the withdrawing message asks new cards too", () => {
    const items = [asked, assistant("a2", `Q2: no longer needed\n\n${card("Q3")}`)];
    expect(isQuestionWithdrawn(items, "a1", "Q2")).toBe(true);
  });

  it("does not apply to a card from before the latest questions", () => {
    const items = [asked, assistant("a2", card("Q3")), assistant("a3", "Q1: no longer needed")];
    expect(isQuestionWithdrawn(items, "a1", "Q1")).toBe(false);
  });

  it("does not apply to a card the user answers, before or after the withdrawal", () => {
    const withdrawal = assistant("a2", "Q1: no longer needed");
    expect(isQuestionWithdrawn([asked, user("u1", "Q1: Yes"), withdrawal], "a1", "Q1")).toBe(false);
    expect(isQuestionWithdrawn([asked, withdrawal, user("u1", "Q1: No")], "a1", "Q1")).toBe(false);
  });

  it("ignores a streaming message, a user's line and lines before the card", () => {
    expect(
      isQuestionWithdrawn([asked, assistant("a2", "Q1: no longer needed", true)], "a1", "Q1"),
    ).toBe(false);
    expect(isQuestionWithdrawn([asked, user("u1", "Q1: no longer needed")], "a1", "Q1")).toBe(
      false,
    );
    expect(isQuestionWithdrawn([assistant("a0", "Q1: no longer needed"), asked], "a1", "Q1")).toBe(
      false,
    );
  });
});

describe("findQuestionRefs", () => {
  it.each([
    ["in parentheses", "your Linear team key (Q40)", ["Q40"]],
    ["in a list of ids", "Q40, Q45 and Q46 are at the end", ["Q40", "Q45", "Q46"]],
    ["before a colon or dash", "Q7: yes, Q8–Q9", ["Q7", "Q8", "Q9"]],
    ["inside other words", "FAQ40, Q40a, Q4_2, QQ1", []],
    ["with no number or a leading zero", "Q, Q0, Q01", []],
  ])("finds ids %s", (_name, text, ids) => {
    expect(findQuestionRefs(text).map((ref) => ref.id)).toEqual(ids);
  });

  it("reports where each id is", () => {
    expect(findQuestionRefs("see (Q12)")).toEqual([{ id: "Q12", start: 5, end: 8 }]);
  });
});

describe("latestQuestionCards", () => {
  const card = (id: string, prompt: string) => `> **${id} · ${prompt}**\n> - A\n> - B`;
  const assistant = (messageId: string, text: string, streaming = false) => ({
    item: { type: "assistant_message", messageId, text, streaming },
  });

  it("maps each id to its newest card, so a re-asked question lands on the live one", () => {
    const items = [
      assistant("m1", card("Q40", "Team key?")),
      { item: { type: "user_message", messageId: "u1", text: card("Q41", "Not asked") } },
      assistant("m2", `${card("Q40", "Team key, again?")}\n\n${card("Q45", "Label?")}`),
      assistant("m3", "Q40 and Q45 are above."),
      assistant("m4", card("Q45", "Still streaming?"), true),
    ];
    expect(latestQuestionCards(items)).toEqual(
      new Map([
        ["Q40", { messageId: "m2", prompt: "Team key, again?" }],
        ["Q45", { messageId: "m2", prompt: "Label?" }],
      ]),
    );
  });
});

describe("hastQuestionRefs", () => {
  const linkedIds = (markdown: string) => {
    const tree = wordsHast(markdown, {
      math: false,
      breaks: false,
      escapeHtml: false,
      insights: false,
      extensions: { hastTransforms: [hastQuestionRefs] },
    });
    const ids: string[] = [];
    const visit = (node: {
      type: string;
      tagName?: string;
      properties?: Record<string, unknown>;
      children?: unknown[];
    }) => {
      const href = typeof node.properties?.href === "string" ? node.properties.href : undefined;
      if (node.tagName === "a" && href?.startsWith("t3-context://v1/question/")) {
        ids.push(href.slice("t3-context://v1/question/".length));
      }
      for (const child of node.children ?? []) visit(child as typeof node);
    };
    visit(tree);
    return ids;
  };

  it.each([
    ["prose, lists and emphasis", "I need (Q40).\n\n- Q45 and *Q46*", ["Q40", "Q45", "Q46"]],
    ["code", "`Q40` and\n\n```\nQ41\n```", []],
    ["existing links", "[about Q40](https://example.com)", []],
    ["a card's own header line", "> **Q40 · Which key?**\n> - A\n> - B", []],
    ["bold that only mentions an id", "**Q40 is still open**", ["Q40"]],
  ])("links ids in %s", (_name, markdown, ids) => {
    expect(linkedIds(markdown)).toEqual(ids);
  });
});

describe("attachQuestionQuoteSources", () => {
  const questionSources = (markdown: string) => {
    const tree = wordsHast(markdown, {
      math: false,
      breaks: false,
      escapeHtml: false,
      insights: false,
      extensions: {},
    });
    return tree.children
      .filter(
        (child): child is Element =>
          child.type === "element" &&
          child.tagName === "blockquote" &&
          typeof child.properties.dataQuestionSource === "string",
      )
      .map((child) => child.properties.dataQuestionSource);
  };

  it("tags choice and free-text question blockquotes with their markdown source and leaves ordinary quotes untouched", () => {
    const markdown = [
      "> An ordinary quote",
      "",
      "> **Q1 · Which config?**",
      ">",
      "> - app.config.json _(recommended)_",
      "> - settings.json",
      "",
      "> **Q2 · Default name?**",
      "> _Reply with Q2: the name._",
    ].join("\n");
    expect(questionSources(markdown)).toEqual([
      "> **Q1 · Which config?**\n>\n> - app.config.json _(recommended)_\n> - settings.json",
      "> **Q2 · Default name?**\n> _Reply with Q2: the name._",
    ]);
  });
});

describe("question card messages in the timeline", () => {
  const at = (second: number) => `2026-01-01T00:00:${String(second).padStart(2, "0")}Z`;
  const runId = RunId.make("run-questions");
  const questionCard = (id: string) => `> **${id} · Ship it?**\n>\n> - Yes _(recommended)_\n> - No`;
  const messageEntry = (
    id: string,
    role: "user" | "assistant",
    text: string,
    second: number,
    options?: {
      readonly inputIntent?: "turn_start" | "steer";
      readonly streaming?: boolean;
      readonly attempt?: TimelineEntry["attempt"];
    },
  ): TimelineEntry => ({
    kind: "message",
    id,
    createdAt: at(second),
    ...(options?.attempt ? { attempt: options.attempt } : {}),
    message: {
      id: MessageId.make(id),
      role,
      text,
      runId,
      ...(options?.inputIntent ? { inputIntent: options.inputIntent } : {}),
      createdAt: at(second),
      updatedAt: at(second),
      streaming: options?.streaming ?? false,
    },
  });
  const workEntry = (
    id: string,
    second: number,
    attempt?: TimelineEntry["attempt"],
  ): TimelineEntry => ({
    kind: "work",
    id,
    createdAt: at(second),
    ...(attempt ? { attempt } : {}),
    entry: { id, createdAt: at(second), runId, label: "Ran check", tone: "tool" },
  });

  it("keeps a finished assistant message with question cards visible when a later message arrives in the same run", () => {
    const timelineEntries: ReadonlyArray<TimelineEntry> = [
      messageEntry("prompt", "user", "Check status", 0, { inputIntent: "turn_start" }),
      workEntry("work-before", 2),
      messageEntry(
        "asks-questions",
        "assistant",
        `${questionCard("Q1")}\n\n${questionCard("Q2")}`,
        5,
      ),
      messageEntry("answer-q1", "user", "Q1: Yes", 10, { inputIntent: "steer" }),
      messageEntry("commentary", "assistant", "Checking one more thing", 12),
      workEntry("work-after", 13),
      messageEntry("final-update", "assistant", "Noted on Q1.", 15),
    ];

    const settledInput = {
      timelineEntries,
      latestRun: { runId, status: "completed" as const, startedAt: at(0), completedAt: at(15) },
      isWorking: false,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    };

    const rows = deriveMessagesTimelineRows(settledInput);
    expect(rows.map((row) => row.id)).toEqual([
      "prompt",
      `turn-fold:${runId}`,
      "asks-questions",
      "answer-q1",
      `turn-fold:${runId}:steer:answer-q1`,
      "final-update",
    ]);
    expect(timelineTurnFoldRunIdsByEntryId(settledInput).has("asks-questions")).toBe(false);
    expect(timelineTurnFoldRunIdsByEntryId(settledInput).has("commentary")).toBe(true);

    const zenRows = deriveMessagesTimelineRows({ ...settledInput, toolCallVisibility: "zen" });
    expect(zenRows.map((row) => row.id)).toEqual([
      "prompt",
      "asks-questions",
      "answer-q1",
      "final-update",
    ]);
  });

  it("keeps finished question cards visible in zen mode while the run is still active, but not while streaming", () => {
    const timelineEntries: ReadonlyArray<TimelineEntry> = [
      messageEntry("prompt", "user", "Start", 0, { inputIntent: "turn_start" }),
      messageEntry("finished-questions", "assistant", questionCard("Q1"), 5, { streaming: false }),
      workEntry("work-next", 6),
      messageEntry("streaming-questions", "assistant", questionCard("Q2"), 8, { streaming: true }),
    ];

    const rows = deriveMessagesTimelineRows({
      timelineEntries,
      latestRun: { runId, status: "running", startedAt: at(0), completedAt: null },
      isWorking: true,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
      toolCallVisibility: "zen",
    });
    expect(rows.map((row) => row.id)).toContain("finished-questions");
    expect(rows.map((row) => row.id)).not.toContain("streaming-questions");
  });

  it("does not collapse a finished question-card message inside a superseded attempt", () => {
    const supersededAttempt = {
      id: RunAttemptId.make("attempt-1"),
      runId,
      attemptOrdinal: 1,
      rootNodeId: NodeId.make("node-1"),
      status: "superseded" as const,
      completedAt: DateTime.makeUnsafe(at(10)),
    };
    const nextAttempt = {
      id: RunAttemptId.make("attempt-2"),
      runId,
      attemptOrdinal: 2,
      rootNodeId: NodeId.make("node-2"),
      status: "running" as const,
      completedAt: null,
    };
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        messageEntry("prompt", "user", "Start", 0, {
          inputIntent: "turn_start",
          attempt: supersededAttempt,
        }),
        messageEntry("asks-questions", "assistant", questionCard("Q1"), 4, {
          attempt: supersededAttempt,
        }),
        workEntry("old-work", 6, supersededAttempt),
        messageEntry("steer", "user", "Q1: Yes", 10, {
          inputIntent: "steer",
          attempt: nextAttempt,
        }),
        messageEntry("next-reply", "assistant", "Working on it", 12, {
          streaming: true,
          attempt: nextAttempt,
        }),
      ],
      latestRun: { runId, status: "running", startedAt: at(0), completedAt: null },
      isWorking: true,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });
    expect(rows.map((row) => row.id)).toContain("asks-questions");
  });

  it("still folds an earlier assistant message whose question syntax is only inside a code fence", () => {
    const fenced = "```md\n> **Q1 · Example?**\n>\n> - Yes\n> - No\n```";
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        messageEntry("prompt", "user", "Show format", 0, { inputIntent: "turn_start" }),
        messageEntry("example-only", "assistant", fenced, 2),
        messageEntry("final", "assistant", "Here you go.", 5),
      ],
      latestRun: { runId, status: "completed", startedAt: at(0), completedAt: at(5) },
      isWorking: false,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });
    expect(rows.map((row) => row.id)).toEqual(["prompt", `turn-fold:${runId}`, "final"]);
  });
});
