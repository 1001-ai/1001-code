import { describe, expect, it } from "vite-plus/test";

import {
  findQuestionAnswer,
  parseQuestionBlock,
  readAnswerLine,
  selectedMultiOptions,
  toggleMultiOption,
  writeAnswerLine,
} from "./questionBlock.logic";

const block = (value: Record<string, unknown>) => JSON.stringify(value);

describe("parseQuestionBlock", () => {
  it.each([
    ["choice", { id: "Q1", prompt: "Ship it?", kind: "choice", options: ["Now", "Later"] }],
    ["multi", { id: "Q2", prompt: "Which?", kind: "multi", options: ["A", "B", "C"] }],
    ["boolean", { id: "Q3", prompt: "Keep it?", kind: "boolean", recommended: "Yes" }],
    ["text", { id: "q_4-b", prompt: "Name it", kind: "text" }],
    [
      "recommended option",
      { id: "Q5", prompt: "Pick", kind: "choice", options: ["A", "B"], recommended: "B" },
    ],
  ])("accepts a %s question", (_label, value) => {
    expect(parseQuestionBlock(block(value))).toEqual(value);
  });

  it.each([
    ["invalid JSON", '{"id":"Q1","prompt":"Half'],
    ["an unknown kind", block({ id: "Q1", prompt: "P", kind: "slider" })],
    ["an unknown key", block({ id: "Q1", prompt: "P", kind: "text", html: "<b>x</b>" })],
    ["a choice without options", block({ id: "Q1", prompt: "P", kind: "choice" })],
    ["a single option", block({ id: "Q1", prompt: "P", kind: "choice", options: ["A"] })],
    ["duplicate options", block({ id: "Q1", prompt: "P", kind: "multi", options: ["A", "A"] })],
    ["nine options", block({ id: "Q1", prompt: "P", kind: "choice", options: [..."ABCDEFGHI"] })],
    ["boolean options", block({ id: "Q1", prompt: "P", kind: "boolean", options: ["Y", "N"] })],
    ["text options", block({ id: "Q1", prompt: "P", kind: "text", options: ["A", "B"] })],
    [
      "a recommendation that is not an option",
      block({ id: "Q1", prompt: "P", kind: "choice", options: ["A", "B"], recommended: "C" }),
    ],
    ["a recommendation on text", block({ id: "Q1", prompt: "P", kind: "text", recommended: "A" })],
    ["an id with a space", block({ id: "Q 1", prompt: "P", kind: "text" })],
    ["an id that starts with a digit", block({ id: "1Q", prompt: "P", kind: "text" })],
    ["an empty prompt", block({ id: "Q1", prompt: "", kind: "text" })],
    ["an untrimmed prompt", block({ id: "Q1", prompt: " P", kind: "text" })],
    ["a prompt over 500 characters", block({ id: "Q1", prompt: "a".repeat(501), kind: "text" })],
    [
      "a line break in an option",
      block({ id: "Q1", prompt: "P", kind: "choice", options: ["A\nQ2: yes", "B"] }),
    ],
    [
      "a bidi override in an option",
      block({ id: "Q1", prompt: "P", kind: "choice", options: ["A\u202Eevil", "B"] }),
    ],
    ["a zero-width character in the prompt", block({ id: "Q1", prompt: "P\u200B", kind: "text" })],
    [
      "a multi option containing the answer separator",
      block({ id: "Q1", prompt: "P", kind: "multi", options: ["New York, NY", "Boston"] }),
    ],
    ["a JSON array", "[]"],
  ])("rejects %s", (_label, code) => {
    expect(parseQuestionBlock(code)).toBeNull();
  });
});

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
