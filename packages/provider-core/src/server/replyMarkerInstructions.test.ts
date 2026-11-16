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
