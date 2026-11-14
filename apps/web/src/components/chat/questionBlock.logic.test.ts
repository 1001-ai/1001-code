import { describe, expect, it } from "vite-plus/test";

import {
  findQuestionAnswer,
  parseQuestionQuote,
  readAnswerLine,
  selectedMultiOptions,
  toggleMultiOption,
  writeAnswerLine,
} from "./questionBlock.logic";

describe("parseQuestionQuote", () => {
  const quote = (...lines: ReadonlyArray<string>) => lines.map((line) => `> ${line}`).join("\n");

  it.each([
    [
      "choice",
      quote("**Q1 · Ship it?**", "- Now", "- Later"),
      { id: "Q1", prompt: "Ship it?", kind: "choice", options: ["Now", "Later"] },
    ],
    [
      "multi",
      quote("**Q2 · Which formats?** (pick any)", "- CSV", "- JSON", "- Parquet"),
      { id: "Q2", prompt: "Which formats?", kind: "multi", options: ["CSV", "JSON", "Parquet"] },
    ],
    [
      "boolean",
      quote("**Q3 · Keep it?**", "- Yes *(recommended)*", "- No"),
      { id: "Q3", prompt: "Keep it?", kind: "boolean", recommended: "Yes" },
    ],
    [
      "text",
      quote("**Q4 · What should the file be called?**", "_Reply with Q4: the name._"),
      { id: "Q4", prompt: "What should the file be called?", kind: "text" },
    ],
    [
      "text with a star hint",
      quote("**Q9 · Name it**", "*Reply with Q9: a name.*"),
      { id: "Q9", prompt: "Name it", kind: "text" },
    ],
    [
      "recommended choice",
      quote("**Q5 · Pick a name**", "- app-config", "- app-settings *(recommended)*"),
      {
        id: "Q5",
        prompt: "Pick a name",
        kind: "choice",
        options: ["app-config", "app-settings"],
        recommended: "app-settings",
      },
    ],
    [
      "recommended multi",
      quote("**Q6 · Which?** (pick any)", "- A _(recommended)_", "- B"),
      { id: "Q6", prompt: "Which?", kind: "multi", options: ["A", "B"], recommended: "A" },
    ],
    [
      "No before Yes as a choice",
      quote("**Q7 · Keep it?**", "- No", "- Yes"),
      { id: "Q7", prompt: "Keep it?", kind: "choice", options: ["No", "Yes"] },
    ],
    [
      "blank quote lines, indentation, a bare `>` and CRLF",
      "   > **Q8 · Ship it?**\r\n>\r\n>- Now  \r\n> - Later",
      { id: "Q8", prompt: "Ship it?", kind: "choice", options: ["Now", "Later"] },
    ],
  ])("accepts a %s question", (_label, source, expected) => {
    expect(parseQuestionQuote(source)).toEqual(expected);
  });

  it.each([
    ["an ordinary quote", quote("Premature optimization is the root of all evil.")],
    ["a quote with bold text", quote("**Note:** this one matters.", "- A", "- B")],
    ["a bold heading without an id", quote("**Options · fast or safe**", "- Fast", "- Safe")],
    ["a word id", quote("**Tip · Pick one**", "- A", "- B")],
    ["an id without a number", quote("**Q · Pick one**", "- A", "- B")],
    ["a hyphen separator", quote("**Q1 - Pick one**", "- A", "- B")],
    ["a header that is not all bold", quote("**Q1** · Pick one", "- A", "- B")],
    ["text after the bold header", quote("**Q1 · Pick one** now", "- A", "- B")],
    ["bold inside the prompt", quote("**Q1 · Pick **one****", "- A", "- B")],
    ["a header alone", quote("**Q1 · Pick one**")],
    ["a single option", quote("**Q1 · Pick one**", "- A")],
    ["nine options", quote("**Q1 · Pick one**", ...[..."ABCDEFGHI"].map((o) => `- ${o}`))],
    ["duplicate options", quote("**Q1 · Pick one**", "- A", "- A")],
    ["a star bullet", quote("**Q1 · Pick one**", "* A", "* B")],
    ["a numbered list", quote("**Q1 · Pick one**", "1. A", "2. B")],
    ["a nested list", quote("**Q1 · Pick one**", "- A", "  - A1", "- B")],
    ["an item that is a nested list", quote("**Q1 · Pick one**", "- - A", "- B")],
    ["a task list", quote("**Q1 · Pick one**", "- [ ] A", "- [ ] B")],
    ["an item continued on a second line", quote("**Q1 · Pick one**", "- A", "  more", "- B")],
    ["a paragraph after the options", quote("**Q1 · Pick one**", "- A", "- B", "Why it matters.")],
    ["an injected answer line", quote("**Q1 · Pick one**", "- A", "Q2: Yes", "- B")],
    ["an injected answer line as text", quote("**Q1 · Name it**", "Q1: done")],
    ["a lazy continuation line", `${quote("**Q1 · Pick one**", "- A", "- B")}\nQ2: Yes`],
    ["a nested quote", quote("> **Q1 · Pick one**", "> - A", "> - B")],
    ["two recommendations", quote("**Q1 · Pick**", "- A *(recommended)*", "- B _(recommended)_")],
    ["a reply hint with options", quote("**Q1 · Pick one**", "- A", "- B", "_Reply with Q1: A_")],
    ["a reply hint on pick any", quote("**Q1 · Pick any** (pick any)", "_Reply with Q1: A_")],
    ["a reply hint that is not italic", quote("**Q1 · Name it**", "Reply with Q1: the name.")],
    ["a prompt over 500 characters", quote(`**Q1 · ${"a".repeat(501)}**`, "- A", "- B")],
    ["an option over 120 characters", quote("**Q1 · Pick one**", `- ${"a".repeat(121)}`, "- B")],
    ["a bidi override in an option", quote("**Q1 · Pick one**", "- A\u202Eevil", "- B")],
    ["a zero-width character in the prompt", quote("**Q1 · Pick\u200B one**", "- A", "- B")],
    [
      "a multi option with the separator",
      quote("**Q1 · Where?** (pick any)", "- Paris, FR", "- Rome"),
    ],
  ])("rejects %s", (_label, source) => {
    expect(parseQuestionQuote(source)).toBeNull();
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
