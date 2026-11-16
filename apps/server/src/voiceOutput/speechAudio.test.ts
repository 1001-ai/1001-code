import { expect, it } from "vite-plus/test";

import { estimateWordTimings, pcm16Mono } from "./speechAudio.ts";

it("spreads the audio over the words by character count, without gaps", () => {
  // 2 + 6 + 2 characters over 800 ms: 80 ms per character.
  expect(estimateWordTimings("Hi  there, yo", 800)).toEqual([
    { start: 0, end: 2, t0Ms: 0, t1Ms: 160 },
    { start: 4, end: 10, t0Ms: 160, t1Ms: 640 },
    { start: 11, end: 13, t0Ms: 640, t1Ms: 800 },
  ]);
});

it("keeps offsets as indexes into the text, and gives no words for blank text", () => {
  const text = "  go 🙂 now ";
  const words = estimateWordTimings(text, 900);
  expect(words.map((word) => text.slice(word.start, word.end))).toEqual(["go", "🙂", "now"]);
  expect(words.at(-1)?.t1Ms).toBe(900);
  expect(estimateWordTimings("   ", 500)).toEqual([]);
});

it("downmixes to clipped 16-bit mono", () => {
  expect([...pcm16Mono(new Float32Array([1, 0, -1, -1, 2, 2, Number.NaN, Number.NaN]), 2)]).toEqual(
    [16383, -32768, 32767, 0],
  );
});
