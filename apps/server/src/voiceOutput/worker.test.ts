// @effect-diagnostics nodeBuiltinImport:off - verifies the isolated worker process, with a stand-in for the native library.
import { expect, it, vi } from "vite-plus/test";

import { loadVoiceOutputModel, voiceOutputWorkerEnvironment } from "./worker.ts";

// Stands in for the bindings: the real library is never loaded in tests.
const fixture = (speak: string) =>
  `data:text/javascript,${encodeURIComponent(`
    export const bindAudioCpp = (koffi, libraryPath) => ({
      loadSpeechModel: (modelPath, options) => ({
        backend: JSON.stringify({ koffi: koffi === undefined, libraryPath, modelPath, options, environment: Object.keys(process.env).sort() }),
        speak: ${speak},
      }),
    });
  `)}`;

const load = (speak: string, signal = new AbortController().signal) =>
  loadVoiceOutputModel({
    libraryPath: "/fixture/libs/libfixture.so",
    backend: "vulkan",
    modelPath: "/fixture/model.gguf",
    threads: 3,
    signal,
    bindingsUrl: fixture(speak),
  });

it("passes only what a process needs to start, never the server's secrets", () => {
  expect(
    voiceOutputWorkerEnvironment({
      PATH: "/usr/bin",
      HOME: "/home/fixture",
      TMPDIR: "/tmp/fixture",
      ANTHROPIC_API_KEY: "fixture-key",
      GITHUB_TOKEN: "fixture-token",
      T3CODE_DEV_AUTH_TOKEN: "fixture-auth",
      NODE_OPTIONS: "--require ./inject.js",
      LD_PRELOAD: "/tmp/inject.so",
      DYLD_INSERT_LIBRARIES: "/tmp/inject.dylib",
    }),
  ).toEqual({
    ELECTRON_RUN_AS_NODE: "1",
    PATH: "/usr/bin",
    HOME: "/home/fixture",
    TMPDIR: "/tmp/fixture",
  });
});

it("speaks in an isolated process that sees a minimal environment", async () => {
  vi.stubEnv("VOICE_OUTPUT_TEST_SECRET", "fixture-secret");
  const model = await load(
    "(request) => ({ samples: new Float32Array([0.5, -0.5, 1, -1]), sampleRate: 24000, channels: 2, request })",
  );
  try {
    const loaded = JSON.parse(model.backend) as {
      koffi: boolean;
      libraryPath: string;
      modelPath: string;
      options: unknown;
      environment: string[];
    };
    expect(loaded).toMatchObject({
      koffi: true,
      libraryPath: "/fixture/libs/libfixture.so",
      modelPath: "/fixture/model.gguf",
      options: { backend: "vulkan", threads: 3 },
    });
    expect(loaded.environment).not.toContain("VOICE_OUTPUT_TEST_SECRET");
    const allowed = Object.keys(voiceOutputWorkerEnvironment(process.env));
    // Node and macOS add a few names of their own to every process, and the test runner's file
    // tracer re-injects itself into every child it sees start.
    const injected = ["FSPY_PAYLOAD", "LD_PRELOAD", "DYLD_INSERT_LIBRARIES"];
    expect(
      loaded.environment.filter(
        (name) => !allowed.includes(name) && !injected.includes(name) && !name.startsWith("__"),
      ),
    ).toEqual([]);
    const audio = await model.speak({ text: "Hello.", voiceId: "amber" });
    expect(audio.sampleRate).toBe(24000);
    expect([...new Int16Array(audio.pcm.buffer, audio.pcm.byteOffset, 2)]).toEqual([0, 0]);
    expect(model.alive).toBe(true);
  } finally {
    await model.dispose();
    vi.unstubAllEnvs();
  }
  expect(model.alive).toBe(false);
});

it("reports a synthesis error and takes one request at a time", async () => {
  const model = await load(
    "(request) => { if (request.text === 'fail') throw new Error('no audio'); return { samples: new Float32Array(2), sampleRate: 16000, channels: 1 }; }",
  );
  try {
    await expect(model.speak({ text: "fail" })).rejects.toThrow("no audio");
    const first = model.speak({ text: "one" });
    await expect(model.speak({ text: "two" })).rejects.toThrow("busy");
    expect((await first).pcm.byteLength).toBe(4);
  } finally {
    await model.dispose();
  }
});

it("kills the process when its signal aborts, failing the request in flight", async () => {
  const controller = new AbortController();
  const model = await load("() => { for (;;) {} }", controller.signal);
  const speaking = model.speak({ text: "never finishes" });
  controller.abort();
  await expect(speaking).rejects.toThrow("stopped");
  await model.dispose();
  expect(model.alive).toBe(false);
  await expect(model.speak({ text: "again" })).rejects.toThrow("stopped");
});
