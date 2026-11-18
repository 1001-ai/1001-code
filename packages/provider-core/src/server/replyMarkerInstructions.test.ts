import { findBackReferences } from "@t3tools/shared/backReferences";
import { splitReLines } from "@t3tools/shared/replyMarkers";
import { describe, expect, it } from "vite-plus/test";

import { buildRuntimeInstructions } from "./runtimeInstructions.ts";

describe("reply marker instructions", () => {
  it("parse their own example as Re: lines", () => {
    const instructions = buildRuntimeInstructions({ harness: "Claude" });
    const example = instructions.split("\n").filter((line) => line.includes("Re:**"));
    const parsed = splitReLines(`${example.join("\n")}\n\nThe body.`);
    expect(example.length).toBeGreaterThan(1);
    expect(parsed?.lines.map((line) => line.excerpt !== null)).toEqual(example.map(() => true));
    expect(parsed?.body).toBe("The body.");
  });
});

describe("back-reference instructions", () => {
  it("parse their own example as a back-reference", () => {
    const instructions = buildRuntimeInstructions({ harness: "Claude" });
    const example = instructions.split("\n").find((line) => line.includes("(↑"));
    const [reference] = findBackReferences(example ?? "");
    const words = reference?.excerpt.split(" ").length ?? 0;
    expect(words).toBeGreaterThanOrEqual(3);
    expect(words).toBeLessThanOrEqual(8);
  });

  it("stay out of the runtime text when the caller sends them on their own", () => {
    const instructions = buildRuntimeInstructions({ harness: "Codex", backReferences: false });
    expect(instructions).not.toContain("<back_references>");
  });
});
