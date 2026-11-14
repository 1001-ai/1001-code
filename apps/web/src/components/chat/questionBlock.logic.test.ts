import { fromMarkdown } from "mdast-util-from-markdown";
import { describe, expect, it } from "vite-plus/test";

import {
  findQuestionAnswer,
  findQuestionRefs,
  latestQuestionCards,
  remarkQuestionRefs,
  readAnswerLine,
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

describe("readAnswerLine", () => {
  it.each([
    ["Q1: Yes", "Q1", "Yes"],
    ["Notes\n  Q1 :  Use the cache  \nQ2: B", "Q1", "Use the cache"],
    ["Q1:", "Q1", null],
    ["Q10: x", "Q1", null],
    ["q1: x", "Q1", null],
    ["See Q1: x", "Q1", null],
  ])("reads %j for %s", (text, id, expected) => {
    expect(readAnswerLine(text, id)).toBe(expected);
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

  it("selects nothing from a typed answer", () => {
    expect(selectedMultiOptions(options, "Whatever works").size).toBe(0);
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

describe("remarkQuestionRefs", () => {
  const linkedIds = (markdown: string) => {
    const tree = fromMarkdown(markdown);
    remarkQuestionRefs()(tree);
    const ids: string[] = [];
    const visit = (node: { type: string; url?: string; children?: unknown[] }) => {
      if (node.type === "link" && node.url?.startsWith("t3-context://v1/question/")) {
        ids.push(node.url.slice("t3-context://v1/question/".length));
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
