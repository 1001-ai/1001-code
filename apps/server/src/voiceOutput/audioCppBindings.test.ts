import type * as Koffi from "koffi";
import { expect, it } from "vite-plus/test";

import { bindAudioCpp } from "./audioCppBindings.ts";

type FakeRequest = {
  text?: string;
  language?: string | null;
  options: Record<string, string>;
  freed: boolean;
};
type FakeResult = { readonly memory: Float32Array; freed: boolean };

/** Stands in for koffi and the library: the same calls, answered in JavaScript. */
const fakeLibrary = (
  setup: {
    readonly offline?: boolean;
    readonly requestOptions?: ReadonlyArray<string>;
    readonly backendsWithoutDevice?: ReadonlyArray<string>;
    readonly runError?: string;
    readonly samples?: ReadonlyArray<number>;
  } = {},
) => {
  const requestOptions = setup.requestOptions ?? ["voice_id", "speed"];
  const samples = setup.samples ?? [0.5, -0.5, 0.25, -0.25];
  const seen = {
    sessions: [] as Array<Record<string, unknown>>,
    requests: [] as Array<FakeRequest>,
    results: [] as Array<FakeResult>,
    modelFreed: false,
  };
  let lastError = "";
  const functions: Record<string, unknown> = {
    audiocpp_abi_version: () => 0x000400,
    audiocpp_last_error: () => lastError,
    audiocpp_status_string: (status: number) => `status ${status}`,
    audiocpp_registry_create: (_config: null, out: [unknown]) => {
      out[0] = {};
      return 0;
    },
    audiocpp_model_load: (_registry: unknown, path: string, ...rest: [null, null, [unknown]]) => {
      rest[2][0] = { path };
      return 0;
    },
    audiocpp_model_free: () => {
      seen.modelFreed = true;
    },
    audiocpp_model_supports: (_model: unknown, task: string, mode: string) =>
      task === "tts" && mode === "offline" && (setup.offline ?? true) ? 1 : 0,
    audiocpp_model_option_count: (_model: unknown, scope: number) =>
      scope === 0 ? requestOptions.length : 0,
    audiocpp_model_option: (_model: unknown, _scope: number, index: number, name: [unknown]) => {
      name[0] = requestOptions[index];
      return 0;
    },
    audiocpp_session_create: (
      _model: unknown,
      task: string,
      mode: string,
      config: { readonly backend: string },
      _options: null,
      out: [unknown],
    ) => {
      seen.sessions.push({ task, mode, ...config });
      if (setup.backendsWithoutDevice?.includes(config.backend)) {
        lastError = "no device";
        return 4;
      }
      out[0] = {};
      return 0;
    },
    audiocpp_request_create: () => {
      const request: FakeRequest = { options: {}, freed: false };
      seen.requests.push(request);
      return request;
    },
    audiocpp_request_free: (request: FakeRequest) => {
      request.freed = true;
    },
    audiocpp_request_set_text: (request: FakeRequest, text: string, language: string | null) => {
      request.text = text;
      request.language = language;
      return 0;
    },
    // Strict, as some real models are: an option the model does not declare fails the request.
    audiocpp_request_set_option: (request: FakeRequest, key: string, value: string) => {
      if (!requestOptions.includes(key)) {
        lastError = `unknown request option: ${key}`;
        return 4;
      }
      request.options[key] = value;
      return 0;
    },
    audiocpp_session_run: (_session: unknown, _request: FakeRequest, out: [unknown]) => {
      if (setup.runError) {
        lastError = setup.runError;
        return 4;
      }
      const result: FakeResult = { memory: Float32Array.from(samples), freed: false };
      seen.results.push(result);
      out[0] = result;
      return 0;
    },
    audiocpp_result_audio: (
      result: FakeResult,
      memory: [unknown],
      frames: [number],
      sampleRate: [number],
      channels: [number],
    ) => {
      memory[0] = result.memory;
      frames[0] = result.memory.length / 2;
      sampleRate[0] = 24_000;
      channels[0] = 2;
      return 0;
    },
    // Freed memory is reused; zeroing it shows whether the caller kept its own copy.
    audiocpp_result_free: (result: FakeResult) => {
      result.memory.fill(0);
      result.freed = true;
    },
  };
  const koffi = {
    load: () => ({
      func: (name: string) => {
        if (!functions[name]) throw new Error(`The library has no ${name}.`);
        return functions[name];
      },
    }),
    pointer: () => ({}),
    opaque: () => ({}),
    struct: () => ({}),
    out: () => ({}),
    view: (memory: Float32Array, bytes: number) =>
      memory.buffer.slice(memory.byteOffset, memory.byteOffset + bytes),
  } as unknown as typeof Koffi;
  return { koffi, seen };
};

const load = (library: ReturnType<typeof fakeLibrary>, backend = "cpu") =>
  bindAudioCpp(library.koffi, "/fixture/libs/libfixture.so").loadSpeechModel(
    "/fixture/model.gguf",
    { backend, threads: 3 },
  );

it("speaks with one offline run and keeps the audio after the result is freed", () => {
  const library = fakeLibrary();
  const audio = load(library).speak({
    text: "Hello.",
    language: "en",
    voiceId: "amber",
    options: { speed: "1.1" },
  });
  expect(library.seen.sessions).toEqual([
    { task: "tts", mode: "offline", backend: "cpu", device: 0, threads: 3 },
  ]);
  expect(library.seen.requests).toEqual([
    { text: "Hello.", language: "en", options: { speed: "1.1", voice_id: "amber" }, freed: true },
  ]);
  expect(library.seen.results.map((result) => result.freed)).toEqual([true]);
  expect({ ...audio, samples: [...audio.samples] }).toEqual({
    samples: [0.5, -0.5, 0.25, -0.25],
    sampleRate: 24_000,
    channels: 2,
  });
});

it("sends no voice id to a model that declares no voice option", () => {
  const library = fakeLibrary({ requestOptions: ["seed"] });
  load(library).speak({ text: "Hello.", voiceId: "only", options: { seed: "42" } });
  expect(library.seen.requests[0]).toMatchObject({ language: null, options: { seed: "42" } });
});

it("falls back to the CPU without a device, and refuses a model without offline speech", () => {
  const library = fakeLibrary({ backendsWithoutDevice: ["vulkan"] });
  expect(load(library, "vulkan").backend).toBe("cpu");
  expect(library.seen.sessions.map((session) => session.backend)).toEqual(["vulkan", "cpu"]);

  const streamingOnly = fakeLibrary({ offline: false });
  expect(() => load(streamingOnly)).toThrow("does not support text to speech");
  expect(streamingOnly.seen).toMatchObject({ modelFreed: true, sessions: [] });
});

it("reports the runtime's reason, and frees the request, when a request fails", () => {
  const failing = fakeLibrary({ runError: "out of memory" });
  expect(() => load(failing).speak({ text: "Hello." })).toThrow(
    "audio.cpp synthesis failed (status 4): out of memory",
  );
  expect(failing.seen.requests.map((request) => request.freed)).toEqual([true]);

  const refused = fakeLibrary();
  expect(() => load(refused).speak({ text: "Hello.", options: { pitch: "2" } })).toThrow(
    "request option pitch failed (status 4): unknown request option: pitch",
  );
  expect(refused.seen.requests.map((request) => request.freed)).toEqual([true]);

  const silent = fakeLibrary({ samples: [] });
  expect(() => load(silent).speak({ text: "Hello." })).toThrow("produced no audio");
  expect(silent.seen.results.map((result) => result.freed)).toEqual([true]);
});
