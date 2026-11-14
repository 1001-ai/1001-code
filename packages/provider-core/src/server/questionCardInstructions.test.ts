import { questionCardsInMarkdown } from "@t3tools/shared/questionCards";
import { describe, expect, it } from "vite-plus/test";

import { buildRuntimeInstructions } from "./runtimeInstructions.ts";

describe("question card instructions", () => {
  it("render their own examples as cards of every kind", () => {
    const cards = questionCardsInMarkdown(buildRuntimeInstructions({ harness: "Codex" }));
    expect(cards.map(({ id, kind }) => `${id} ${kind}`)).toEqual([
      "Q1 choice",
      "Q2 multi",
      "Q3 boolean",
      "Q4 text",
    ]);
    expect(cards[0]?.recommended).toBeDefined();
  });
});
