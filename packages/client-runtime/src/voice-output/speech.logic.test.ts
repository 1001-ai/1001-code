import { expect, it } from "vite-plus/test";

import { splitVoiceOutputSentences, voiceOutputWordAt } from "./speech.logic.ts";

it("cuts a reply into sentences and remembers where each starts", () => {
  const text = 'Done.  It took 3.5 seconds! "Really?" she asked\nNext line… and the rest';
  const sentences = splitVoiceOutputSentences(text, 200);
  expect(sentences.map((sentence) => sentence.text)).toEqual([
    "Done.",
    "It took 3.5 seconds!",
    '"Really?"',
    "she asked",
    "Next line…",
    "and the rest",
  ]);
  for (const sentence of sentences)
    expect(text.slice(sentence.start, sentence.start + sentence.text.length)).toBe(sentence.text);
});

it("does not end a sentence at marks with no space after, however long the run", () => {
  const run = "!".repeat(50_000);
  expect(splitVoiceOutputSentences(`wow${run}x. Next.`, 100_000).map(({ text }) => text)).toEqual([
    `wow${run}x.`,
    "Next.",
  ]);
  expect(splitVoiceOutputSentences('He said "stop!")] now', 200).map(({ text }) => text)).toEqual([
    'He said "stop!")]',
    "now",
  ]);
});

it("drops blank text and cuts an overlong sentence at a space, never inside a surrogate pair", () => {
  expect(splitVoiceOutputSentences("  \n\n  ", 50)).toEqual([]);
  const text = `one two three four ${"🙂".repeat(6)} five`;
  const sentences = splitVoiceOutputSentences(text, 12);
  expect(sentences.every((sentence) => sentence.text.length <= 12)).toBe(true);
  expect(sentences.every((sentence) => !/[\uD800-\uDBFF]$/.test(sentence.text))).toBe(true);
  expect(
    sentences
      .map((sentence) => sentence.text)
      .join("")
      .replaceAll(" ", ""),
  ).toBe(text.replaceAll(" ", ""));
  for (const sentence of sentences)
    expect(text.slice(sentence.start, sentence.start + sentence.text.length)).toBe(sentence.text);
});

it("finds the word at a time, and none outside the audio", () => {
  const words = [
    { start: 0, end: 2, t0Ms: 0, t1Ms: 160 },
    { start: 4, end: 10, t0Ms: 160, t1Ms: 640 },
    { start: 11, end: 13, t0Ms: 640, t1Ms: 800 },
  ];
  expect(voiceOutputWordAt(words, 0)).toBe(words[0]);
  expect(voiceOutputWordAt(words, 159.9)).toBe(words[0]);
  expect(voiceOutputWordAt(words, 160)).toBe(words[1]);
  expect(voiceOutputWordAt(words, 799)).toBe(words[2]);
  expect(voiceOutputWordAt(words, 800)).toBeUndefined();
  expect(voiceOutputWordAt(words, -1)).toBeUndefined();
  expect(voiceOutputWordAt([], 10)).toBeUndefined();
});
