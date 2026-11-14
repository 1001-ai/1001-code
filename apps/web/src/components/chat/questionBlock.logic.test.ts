import { buildRuntimeInstructions } from "@t3tools/provider-core/server/runtimeInstructions";
import { fromMarkdown } from "mdast-util-from-markdown";
import { describe, expect, it } from "vite-plus/test";

import {
  findQuestionAnswer,
  findQuestionRefs,
  latestQuestionCards,
  parseQuestionQuote,
  questionCardsInMarkdown,
  remarkQuestionRefs,
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

describe("questionCardsInMarkdown", () => {
  const card = (id: string, prompt: string) =>
    `> **${id} · ${prompt}**\n>\n> - Yes _(recommended)_\n> - No`;

  it("finds every card in a message, in order", () => {
    const text = `Two things.\n\n${card("Q1", "Ship it?")}\n\n${card("Q2", "Keep it?")}\n\nThanks.`;
    expect(questionCardsInMarkdown(text).map((question) => question.id)).toEqual(["Q1", "Q2"]);
  });

  it("renders the examples in the instructions agents get as cards of every kind", () => {
    const cards = questionCardsInMarkdown(buildRuntimeInstructions({ harness: "Codex" }));
    expect(cards.map(({ id, kind }) => `${id} ${kind}`)).toEqual([
      "Q1 choice",
      "Q2 multi",
      "Q3 boolean",
      "Q4 text",
    ]);
    expect(cards[0]?.recommended).toBeDefined();
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
