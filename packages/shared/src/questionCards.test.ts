import { describe, expect, it } from "vite-plus/test";

import {
  openQuestionCards,
  parseQuestionQuote,
  questionCardsInMarkdown,
  questionWithdrawalsInMarkdown,
  readAnswerLine,
} from "./questionCards.ts";

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
      "multi marked inside the bold",
      quote("**Q25 · Which items should be visible? (pick any)**", "- Limits", "- Cost"),
      {
        id: "Q25",
        prompt: "Which items should be visible?",
        kind: "multi",
        options: ["Limits", "Cost"],
      },
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
      "text with underscores in the hint",
      quote("**Q10 · Name it**", "_Reply with Q10: the file_name, like my_export_"),
      { id: "Q10", prompt: "Name it", kind: "text" },
    ],
    [
      "text with asterisks in a star hint",
      quote("**Q11 · Pattern?**", "*Reply with Q11: a glob such as *.csv*"),
      { id: "Q11", prompt: "Pattern?", kind: "text" },
    ],
    [
      "options that start with marker characters",
      quote("**Q12 · Which value?**", "- -1", "- +5%", "- *args", "- #hash", "- 2024.1"),
      {
        id: "Q12",
        prompt: "Which value?",
        kind: "choice",
        options: ["-1", "+5%", "*args", "#hash", "2024.1"],
      },
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
    [
      "wordy option within the parser headroom",
      quote("**Q13 · Pick one**", `- ${"a".repeat(300)}`, "- Short"),
      { id: "Q13", prompt: "Pick one", kind: "choice", options: ["a".repeat(300), "Short"] },
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
    ["an item that is a heading", quote("**Q1 · Pick one**", "- # A", "- B")],
    ["an item that is a quote", quote("**Q1 · Pick one**", "- >A", "- B")],
    ["an item that is an ordered list", quote("**Q1 · Pick one**", "- 1) A", "- B")],
    ["an item that is a code fence", quote("**Q1 · Pick one**", "- ```A", "- B")],
    ["an item that is a thematic break", quote("**Q1 · Pick one**", "- * * *", "- B")],
    ["an item continued on a second line", quote("**Q1 · Pick one**", "- A", "  more", "- B")],
    ["a paragraph after the options", quote("**Q1 · Pick one**", "- A", "- B", "Why it matters.")],
    ["an injected answer line", quote("**Q1 · Pick one**", "- A", "Q2: Yes", "- B")],
    ["an injected answer line as text", quote("**Q1 · Name it**", "Q1: done")],
    ["a lazy continuation line", `${quote("**Q1 · Pick one**", "- A", "- B")}\nQ2: Yes`],
    ["a nested quote", quote("> **Q1 · Pick one**", "> - A", "> - B")],
    ["two recommendations", quote("**Q1 · Pick**", "- A *(recommended)*", "- B _(recommended)_")],
    ["a reply hint with options", quote("**Q1 · Pick one**", "- A", "- B", "_Reply with Q1: A_")],
    ["a reply hint on pick any", quote("**Q1 · Pick any** (pick any)", "_Reply with Q1: A_")],
    [
      "a reply hint on pick any in the bold",
      quote("**Q1 · Pick (pick any)**", "_Reply with Q1: A_"),
    ],
    ["pick any as the whole prompt", quote("**Q1 ·  (pick any)**", "- A", "- B")],
    ["a reply hint that is not italic", quote("**Q1 · Name it**", "Reply with Q1: the name.")],
    ["a prompt over 500 characters", quote(`**Q1 · ${"a".repeat(501)}**`, "- A", "- B")],
    ["an option over 300 characters", quote("**Q1 · Pick one**", `- ${"a".repeat(301)}`, "- B")],
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

describe("questionCardsInMarkdown", () => {
  const card = (id: string, prompt: string) =>
    `> **${id} · ${prompt}**\n>\n> - Yes _(recommended)_\n> - No`;

  it("finds every card in a message, in order", () => {
    const text = `Two things.\n\n${card("Q1", "Ship it?")}\n\n${card("Q2", "Keep it?")}\n\nThanks.`;
    expect(questionCardsInMarkdown(text).map((question) => question.id)).toEqual(["Q1", "Q2"]);
  });

  it.each([
    ["an ordinary quote", "> Just a quote about Q1."],
    ["a quote in a code fence", `\`\`\`md\n${card("Q1", "Ship it?")}\n\`\`\``],
    ["a quote a lazy line continues", `${card("Q1", "Ship it?")}\nmore text`],
  ])("ignores %s", (_name, text) => {
    expect(questionCardsInMarkdown(text)).toEqual([]);
  });

  it("finds a card after a closed fence", () => {
    const text = `~~~\n${card("Q1", "Old?")}\n~~~\n\n${card("Q2", "New?")}`;
    expect(questionCardsInMarkdown(text).map((question) => question.id)).toEqual(["Q2"]);
  });
});

describe("questionWithdrawalsInMarkdown", () => {
  it("reads each whole `Qn: no longer needed` line once, in order", () => {
    const text =
      "You switched to CSV only, so two questions are moot.\n\n```\nQ2: no longer needed\n```\n  Q3 :  no longer needed \nQ1: no longer needed\r\nQ3: no longer needed";
    expect(questionWithdrawalsInMarkdown(text)).toEqual(["Q3", "Q1"]);
  });

  it.each([
    ["the phrase inside a sentence", "Q1: no longer needed, since you chose CSV."],
    ["another answer", "Q1: skipped"],
    ["a different case", "Q1: No longer needed"],
    ["an id that is not a card's", "Item1: no longer needed"],
    ["inline code", "Write `Q1: no longer needed` to withdraw it."],
    ["a fenced code block", "The format:\n\n```\nQ1: no longer needed\n```"],
    ["a tilde fence", "~~~~md\nQ1: no longer needed\n~~~~"],
    ["an indented code block", "The format:\n\n    Q1: no longer needed"],
    ["a tab-indented code block", "\tQ1: no longer needed"],
  ])("ignores %s", (_name, text) => {
    expect(questionWithdrawalsInMarkdown(text)).toEqual([]);
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

describe("openQuestionCards", () => {
  const card = (id: string) => `> **${id} · Ship ${id}?**\n>\n> - Yes\n> - No`;
  const assistant = (name: string, text: string, streaming = false) => ({
    name,
    role: "assistant",
    text,
    streaming,
  });
  const user = (name: string, text: string) => ({ name, role: "user", text });
  const open = (messages: ReadonlyArray<ReturnType<typeof assistant | typeof user>>) =>
    openQuestionCards(messages).map(({ question, message }) => `${message.name}:${question.id}`);
  const askThree = assistant("a1", ["Q1", "Q2", "Q3"].map(card).join("\n\n"));

  it("keeps each card open until a later user message carries its own answer line", () => {
    expect(open([askThree, user("u1", "Looks good"), user("u2", "Q1: Yes")])).toEqual([
      "a1:Q2",
      "a1:Q3",
    ]);
    expect(
      open([user("u0", "Q1: Yes"), askThree, user("u1", "Q2: No\nQ1: Yes\nQ3: skipped")]),
    ).toEqual([]);
    expect(open([askThree, user("u1", "Q2: dismissed")])).toEqual(["a1:Q1", "a1:Q3"]);
  });

  it("counts only each id's newest card", () => {
    const reask = assistant("a2", card("Q2"));
    expect(open([askThree, user("u1", "Q2: Yes"), reask])).toEqual(["a1:Q1", "a1:Q3", "a2:Q2"]);
    expect(open([askThree, reask, user("u1", "Q2: Yes")])).toEqual(["a1:Q1", "a1:Q3"]);
  });

  it("drops a card withdrawn while its message holds the latest cards", () => {
    const withdraw = (name: string, id: string) => assistant(name, `${id}: no longer needed`);
    expect(open([askThree, withdraw("a2", "Q1")])).toEqual(["a1:Q2", "a1:Q3"]);
    expect(open([askThree, assistant("a2", card("Q4")), withdraw("a3", "Q1")])).toEqual([
      "a1:Q1",
      "a1:Q2",
      "a1:Q3",
      "a2:Q4",
    ]);
  });

  it("ignores streaming messages", () => {
    expect(open([assistant("a1", card("Q1"), true)])).toEqual([]);
    expect(open([askThree, assistant("a2", "Q1: no longer needed", true)])).toHaveLength(3);
  });
});
