import type { VoiceOutputModel } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { pcm16ToFloat32, voiceModelCardState } from "./VoiceOutputSettings.logic";

const model = (install: VoiceOutputModel["install"]): VoiceOutputModel => ({
  id: "lantern",
  name: "Lantern",
  license: "Apache-2.0",
  licenseUrl: "https://example.com/licenses/apache-2.0",
  sampleText: "This is how I sound.",
  voices: [{ id: "amber", name: "Amber" }],
  install,
});

it("reads 16-bit samples from bytes that start at an odd offset", () => {
  // The speak response puts the audio after a header of any length.
  const body = new Uint8Array([9, 0x00, 0x80, 0x00, 0x40, 0xff, 0x7f, 7]);
  expect([...pcm16ToFloat32(body.subarray(1, 7))]).toEqual([-1, 0.5, 32767 / 32768]);
  expect(pcm16ToFloat32(new Uint8Array(0))).toHaveLength(0);
});

it.each([
  [
    { state: "downloadable", size: 200 },
    null,
    { state: "downloadable", progress: 0, problem: null },
  ],
  [
    { state: "downloadable", size: 200 },
    "lantern",
    { state: "downloading", progress: 0, problem: null },
  ],
  [
    { state: "downloading", size: 200, downloaded: 50 },
    null,
    { state: "downloading", progress: 25, problem: null },
  ],
  [
    { state: "verifying", size: 200, downloaded: 200 },
    "lantern",
    { state: "verifying", progress: 100, problem: null },
  ],
  [{ state: "installed", size: 200 }, null, { state: "installed", progress: 0, problem: null }],
] as const)("shows %j (requested: %j) as %j", (install, requested, expected) => {
  expect(voiceModelCardState(model(install), requested)).toEqual(expected);
});

it("keeps a failed install's reason until the next download starts", () => {
  const failed = model({ state: "downloadable", size: 200, failure: "verification" });
  expect(voiceModelCardState(failed, null).problem).toContain("Verification failed");
  expect(voiceModelCardState(failed, "lantern")).toEqual({
    state: "downloading",
    progress: 0,
    problem: null,
  });
  expect(
    voiceModelCardState(model({ state: "downloadable", size: 200, failure: "download" }), null)
      .problem,
  ).toContain("download failed");
});
