import { describe, expect, it } from "vite-plus/test";

import {
  decodeVoiceOutputSpeech,
  encodeVoiceOutputSpeech,
  parseVoiceOutputFileUrl,
} from "./voiceOutput.ts";

const speech = {
  sampleRate: 24_000,
  timing: "estimated" as const,
  words: [
    { start: 0, end: 5, t0Ms: 0, t1Ms: 312.5 },
    { start: 6, end: 8, t0Ms: 312.5, t1Ms: 437.5 },
  ],
  pcm: new Uint8Array([0, 1, 254, 255]),
};

describe("the speak response", () => {
  it("carries a length-prefixed JSON header, then the PCM bytes", () => {
    const body = encodeVoiceOutputSpeech(speech);
    const headerLength = new DataView(body.buffer).getUint32(0, true);
    expect(JSON.parse(new TextDecoder().decode(body.subarray(4, 4 + headerLength)))).toEqual({
      sampleRate: 24_000,
      timing: "estimated",
      words: speech.words,
    });
    expect([...body.subarray(4 + headerLength)]).toEqual([0, 1, 254, 255]);
    // A body that starts inside a larger buffer decodes from its own offset.
    const framed = new Uint8Array(body.length + 3);
    framed.set(body, 3);
    expect(decodeVoiceOutputSpeech(framed.subarray(3))).toEqual(speech);
  });

  it.each([
    ["too short for a length", new Uint8Array([1, 0])],
    ["a length past the end", new Uint8Array([255, 0, 0, 0, 123])],
    [
      "a header that is not the schema",
      (() => {
        const header = new TextEncoder().encode(JSON.stringify({ sampleRate: "fast" }));
        const body = new Uint8Array(4 + header.length);
        new DataView(body.buffer).setUint32(0, header.length, true);
        body.set(header, 4);
        return body;
      })(),
    ],
    [
      "half a sample",
      (() => {
        const body = encodeVoiceOutputSpeech(speech);
        return body.subarray(0, body.length - 1);
      })(),
    ],
  ])("refuses a body with %s", (_, body) => {
    expect(() => decodeVoiceOutputSpeech(body)).toThrow();
  });
});

it("reads the repository, commit and path of a pinned Hugging Face file only", () => {
  const revision = "0123456789abcdef0123456789abcdef01234567";
  expect(
    parseVoiceOutputFileUrl(
      `https://huggingface.co/example/lantern-gguf/resolve/${revision}/weights/lantern.gguf`,
    ),
  ).toEqual({ repository: "example/lantern-gguf", revision, path: "weights/lantern.gguf" });
  for (const url of [
    `https://huggingface.co/example/lantern-gguf/resolve/main/lantern.gguf`,
    `https://huggingface.co/example/lantern-gguf/blob/${revision}/lantern.gguf`,
    `https://huggingface.co/example/lantern-gguf/resolve/${revision}/./lantern.gguf`,
    `https://huggingface.co@example.com/example/lantern-gguf/resolve/${revision}/lantern.gguf`,
    `https://example.com/example/lantern-gguf/resolve/${revision}/lantern.gguf`,
  ])
    expect(parseVoiceOutputFileUrl(url)).toBeUndefined();
});
