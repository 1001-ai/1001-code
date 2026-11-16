// @effect-diagnostics nodeBuiltinImport:off - hashes fixture bytes the way the catalog pins them.
import * as NodeCrypto from "node:crypto";
import * as PlatformNodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { VOICE_OUTPUT_CATALOG_FILE, type TeamCatalogSnapshot } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/http";
import { beforeEach, vi } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import * as SpeechModelStore from "../speech/SpeechModelStore.ts";
import * as TeamCatalog from "../teamCatalog/TeamCatalog.ts";
import { AUDIO_CPP_VERSION, GlibcVersion, RuntimeBuilds } from "./runtime.ts";
import { tarGz } from "./tarFixture.ts";
import * as VoiceOutput from "./VoiceOutput.ts";

const worker = vi.hoisted(() => ({
  load: vi.fn(),
  speak: vi.fn(),
  dispose: vi.fn(async () => {}),
}));
vi.mock("./worker.ts", () => ({ loadVoiceOutputModel: worker.load }));

const sha256 = (bytes: Uint8Array) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");

const LIBRARY = "libs/libfixture.so.0.1.0";
const archive = tarGz([
  { name: LIBRARY, data: new TextEncoder().encode("not a real library") },
  { name: "libs/libfixture.so", linkTo: "libfixture.so.0.1.0" },
]);
const runtime = {
  filename: "audio-fixture-lib-linux-x64.tar.gz",
  url: "https://example.com/releases/audio-fixture-lib-linux-x64.tar.gz",
  size: archive.length,
  sha256: sha256(archive),
  library: LIBRARY,
  backend: "vulkan" as const,
  minimumGlibc: "2.28",
};
const modelBytes = Uint8Array.from({ length: 96 }, (_, index) => (index * 11) % 256);
const SPLIT = 40;
const REVISION = "0123456789abcdef0123456789abcdef01234567";
const MODEL_URL = `https://huggingface.co/example/lantern-gguf/resolve/${REVISION}/lantern-f16.gguf`;
const voicesFile = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    version: 1,
    models: [
      {
        id: "lantern",
        name: "Lantern",
        license: "Apache-2.0",
        licenseUrl: "https://example.com/licenses/apache-2.0",
        file: { url: MODEL_URL, size: modelBytes.length, sha256: sha256(modelBytes) },
        voices: [
          { id: "amber", name: "Amber" },
          { id: "slate", name: "Slate" },
        ],
        sampleText: "This is how I sound.",
        language: "en",
        requestOptions: { speed: "1.1" },
        ...overrides,
      },
    ],
  });

const snapshot = (source: string | null): TeamCatalogSnapshot => ({
  source,
  defaultSource: null,
  revision: source === null ? null : "fixture-revision",
  fetchedAt: source === null ? null : "2026-01-01T00:00:00.000Z",
  refreshing: false,
  error: null,
  projects: [],
  invalid: [],
  viewer: { login: null, problem: null },
});

type Body = (
  request: HttpClientRequest.HttpClientRequest,
  offset: number,
) => Stream.Stream<Uint8Array, HttpClientError.HttpClientError>;
const whole =
  (bytes: Uint8Array): Body =>
  (_, offset) =>
    Stream.succeed(bytes.subarray(offset));

const world = {
  source: "https://example.com/team/catalog.git" as string | null,
  voices: voicesFile() as string | null,
  requests: [] as HttpClientRequest.HttpClientRequest[],
  bodies: new Map<string, { readonly size: number; readonly body: Body }>(),
};

beforeEach(() => {
  vi.clearAllMocks();
  worker.speak.mockImplementation(async () => ({
    sampleRate: 24_000,
    // One second of 16-bit mono audio.
    pcm: new Uint8Array(48_000),
  }));
  worker.load.mockImplementation(async () => ({
    backend: "cpu",
    alive: true,
    speak: worker.speak,
    dispose: worker.dispose,
  }));
  world.source = "https://example.com/team/catalog.git";
  world.voices = voicesFile();
  world.requests = [];
  world.bodies = new Map([
    [runtime.url, { size: archive.length, body: whole(archive) }],
    [MODEL_URL, { size: modelBytes.length, body: whole(modelBytes) }],
  ]);
});

const client = HttpClient.make((request) =>
  Effect.sync(() => {
    world.requests.push(request);
    const file = world.bodies.get(request.url);
    if (!file) return HttpClientResponse.fromWeb(request, new Response(null, { status: 404 }));
    const range = /^bytes=(\d+)-$/.exec(request.headers["range"] ?? "");
    const offset = range ? Number(range[1]) : 0;
    return Object.defineProperty(
      HttpClientResponse.fromWeb(
        request,
        new Response(null, {
          status: range ? 206 : 200,
          headers: range
            ? {
                "content-range": `bytes ${offset}-${file.size - 1}/${file.size}`,
                "content-length": String(file.size - offset),
              }
            : { "content-length": String(file.size) },
        }),
      ),
      "stream",
      { value: file.body(request, offset) },
    );
  }),
);

const layer = VoiceOutput.layer.pipe(
  Layer.provide(
    SpeechModelStore.layer.pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, client))),
  ),
  Layer.provide(
    Layer.mock(TeamCatalog.TeamCatalog)({
      snapshot: Effect.sync(() => snapshot(world.source)),
      refresh: () => Effect.sync(() => snapshot(world.source)),
      readFile: (file) =>
        Effect.sync(() => (file === VOICE_OUTPUT_CATALOG_FILE ? world.voices : null)),
    }),
  ),
);

type Host = { readonly libc?: "gnu" | "musl"; readonly runtime?: typeof runtime };
const host = <A, E, R>(effect: Effect.Effect<A, E, R>, options: Host = {}) =>
  Effect.gen(function* () {
    // The model store looks for copies under the home folder; keep it inside the test's state.
    const home = (yield* ServerConfig.ServerConfig).baseDir;
    return yield* effect.pipe(
      Effect.provideService(HostProcess.HomeDirectory, home),
      Effect.provideService(HostProcess.Platform, "linux"),
      Effect.provideService(HostProcess.Architecture, "x64"),
      Effect.provideService(HostProcess.LinuxLibc, options.libc ?? "gnu"),
      Effect.provideService(GlibcVersion, "2.39"),
      Effect.provideService(RuntimeBuilds, { "linux-x64": options.runtime ?? runtime }),
    );
  });

const dependencies = ServerConfig.layerTest("/tmp", { prefix: "voice-output-" }).pipe(
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, PlatformNodeCrypto.layer)),
);

const run = <A, E>(
  test: Effect.Effect<
    A,
    E,
    VoiceOutput.VoiceOutput | ServerConfig.ServerConfig | FileSystem.FileSystem | Path.Path
  >,
  options: Host = {},
) => host(test.pipe(Effect.provide(layer)), options).pipe(Effect.provide(dependencies));

const paths = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const path = yield* Path.Path;
  return {
    models: path.join(config.stateDir, "speech", "models"),
    runtime: path.join(
      config.stateDir,
      "speech",
      "runtime",
      `audio-cpp-${AUDIO_CPP_VERSION}-linux-x64`,
    ),
    selection: path.join(config.stateDir, "voice-output", "selection.json"),
  };
});

const listing = (directory: string) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.readDirectory(directory)),
    Effect.map((names) => names.toSorted()),
    Effect.orElseSucceed(() => [] as string[]),
  );

it.effect("says why no voice is offered: no catalog, no file, an invalid file", () =>
  run(
    Effect.gen(function* () {
      const voices = yield* VoiceOutput.VoiceOutput;
      world.source = null;
      expect(yield* voices.catalog).toMatchObject({
        unavailable: { reason: "no-team-catalog" },
        models: [],
        selection: null,
      });
      world.source = "https://example.com/team/catalog.git";
      world.voices = null;
      expect((yield* voices.catalog).unavailable).toEqual({
        reason: "no-voices-file",
        message: "The team catalog has no voices/voices.json.",
      });
      world.voices = voicesFile({
        file: { url: "https://example.com/lantern.gguf", size: 1, sha256: "ab".repeat(32) },
      });
      const invalid = yield* voices.catalog;
      expect(invalid.unavailable?.reason).toBe("invalid-voices-file");
      expect(invalid.unavailable?.message).toContain("huggingface.co");
      expect(invalid.models).toEqual([]);
      expect(yield* Effect.flip(voices.download("lantern"))).toMatchObject({
        reason: "unavailable",
      });
      expect(world.requests).toEqual([]);
    }),
  ),
);

it.effect("offers nothing on a platform the runtime does not support", () =>
  run(
    Effect.gen(function* () {
      const voices = yield* VoiceOutput.VoiceOutput;
      expect(yield* voices.catalog).toMatchObject({
        unavailable: { reason: "unsupported-platform" },
        runtime: { state: "unsupported" },
        models: [],
      });
      expect(yield* Effect.flip(voices.speak({ text: "Hello." }))).toMatchObject({
        reason: "unavailable",
      });
    }),
    { libc: "musl" },
  ),
);

it.effect("installs the runtime with the first model, resuming and verifying each transfer", () =>
  run(
    Effect.gen(function* () {
      const voices = yield* VoiceOutput.VoiceOutput;
      const fs = yield* FileSystem.FileSystem;
      const where = yield* paths;
      const total = archive.length + modelBytes.length;
      expect(yield* voices.catalog).toMatchObject({
        unavailable: null,
        runtime: { state: "missing", size: archive.length },
        models: [{ id: "lantern", install: { state: "downloadable", size: total } }],
      });

      const modelStarted = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      // The model's first transfer breaks part-way; the retry asks for the rest.
      world.bodies.set(MODEL_URL, {
        size: modelBytes.length,
        body: (request, offset) =>
          offset > 0
            ? Stream.succeed(modelBytes.subarray(offset))
            : Stream.concat(
                Stream.succeed(modelBytes.subarray(0, SPLIT)),
                Stream.fromEffect(
                  Deferred.succeed(modelStarted, undefined).pipe(
                    Effect.andThen(Deferred.await(release)),
                  ),
                ).pipe(
                  Stream.drain,
                  Stream.concat(
                    Stream.fail(
                      new HttpClientError.HttpClientError({
                        reason: new HttpClientError.TransportError({
                          request,
                          cause: new Error("reset"),
                        }),
                      }),
                    ),
                  ),
                ),
              ),
      });
      const download = yield* voices.download("lantern").pipe(Effect.forkChild);
      yield* Deferred.await(modelStarted);
      expect((yield* voices.catalog).models[0]?.install).toEqual({
        state: "downloading",
        size: total,
        downloaded: archive.length + SPLIT,
      });
      expect(yield* Effect.flip(voices.remove("lantern"))).toMatchObject({ reason: "busy" });
      yield* Deferred.succeed(release, undefined);
      const installed = yield* Fiber.join(download);

      expect(installed).toMatchObject({
        runtime: { state: "installed" },
        models: [{ install: { state: "installed", size: modelBytes.length } }],
      });
      expect(world.requests.map((request) => [request.url, request.headers["range"]])).toEqual([
        [runtime.url, undefined],
        [MODEL_URL, undefined],
        [MODEL_URL, `bytes=${SPLIT}-`],
      ]);
      // The archive was only a transfer: the model folder holds the model, the runtime folder the library.
      expect(yield* listing(where.models)).toEqual([
        "lantern-f16.gguf",
        "lantern-f16.gguf.verified",
      ]);
      expect(yield* listing(where.runtime)).toEqual([".t3-complete", "libs"]);
      expect([...(yield* fs.readFile(`${where.models}/lantern-f16.gguf`))]).toEqual([
        ...modelBytes,
      ]);

      const before = world.requests.length;
      yield* voices.download("lantern");
      expect(world.requests).toHaveLength(before);
    }),
  ),
);

it.effect.each([
  ["the model", MODEL_URL, modelBytes.length, [".t3-complete", "libs"]],
  ["the runtime archive", runtime.url, archive.length, []],
] as const)(
  "installs nothing when %s does not match its checksum, and says so",
  ([, url, size, runtimeFolder]) =>
    run(
      Effect.gen(function* () {
        const voices = yield* VoiceOutput.VoiceOutput;
        const where = yield* paths;
        world.bodies.set(url, { size, body: () => Stream.succeed(new Uint8Array(size)) });
        expect(yield* Effect.flip(voices.download("lantern"))).toMatchObject({
          _tag: "VoiceOutputError",
          reason: "verification",
        });
        expect(yield* listing(where.models)).toEqual([]);
        expect(yield* listing(where.runtime)).toEqual(runtimeFolder);
        expect((yield* voices.catalog).models[0]?.install).toMatchObject({
          state: "downloadable",
          failure: "verification",
        });
        expect(
          yield* Effect.flip(voices.select({ modelId: "lantern", voiceId: "amber" })),
        ).toMatchObject({ reason: "not-installed" });
      }),
    ),
);

it.effect("refuses a runtime archive that reaches outside its folder", () => {
  const escaping = tarGz([
    { name: LIBRARY, data: new Uint8Array([1]) },
    { name: "../evil.txt", data: new Uint8Array([1]) },
  ]);
  return run(
    Effect.gen(function* () {
      const voices = yield* VoiceOutput.VoiceOutput;
      const where = yield* paths;
      world.bodies.set(runtime.url, { size: escaping.length, body: whole(escaping) });
      expect(yield* Effect.flip(voices.download("lantern"))).toMatchObject({
        reason: "verification",
      });
      expect(yield* listing(where.runtime)).toEqual([]);
      expect(yield* listing(where.models)).toEqual([]);
    }),
    { runtime: { ...runtime, size: escaping.length, sha256: sha256(escaping) } },
  );
});

it.effect("cancels a download and leaves no partial file", () =>
  run(
    Effect.gen(function* () {
      const voices = yield* VoiceOutput.VoiceOutput;
      const where = yield* paths;
      const started = yield* Deferred.make<void>();
      world.bodies.set(MODEL_URL, {
        size: modelBytes.length,
        body: () =>
          Stream.concat(
            Stream.succeed(modelBytes.subarray(0, SPLIT)),
            Stream.fromEffect(Deferred.succeed(started, undefined)).pipe(
              Stream.drain,
              Stream.concat(Stream.never),
            ),
          ),
      });
      const download = yield* voices.download("lantern").pipe(Effect.forkChild);
      yield* Deferred.await(started);
      expect((yield* voices.cancel("lantern")).models[0]?.install.state).toBe("downloadable");
      expect((yield* Fiber.join(download)).models[0]?.install).toEqual({
        state: "downloadable",
        size: modelBytes.length,
      });
      expect(yield* listing(where.models)).toEqual([]);
    }),
  ),
);

it.effect(
  "has no default voice; a chosen one speaks, survives a restart and goes with its model",
  () =>
    host(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const where = yield* paths;
        yield* Effect.gen(function* () {
          const voices = yield* VoiceOutput.VoiceOutput;
          yield* voices.download("lantern");
          expect((yield* voices.catalog).selection).toBeNull();
          expect(yield* Effect.flip(voices.speak({ text: "Hello." }))).toMatchObject({
            reason: "no-voice-selected",
          });
          expect(
            yield* Effect.flip(voices.select({ modelId: "lantern", voiceId: "nobody" })),
          ).toMatchObject({ reason: "unknown-voice" });
          const chosen = { modelId: "lantern", voiceId: "slate" };
          expect((yield* voices.select(chosen)).selection).toEqual(chosen);
          expect(JSON.parse(yield* fs.readFileString(where.selection))).toEqual(chosen);

          const speech = yield* voices.speak({ text: "Hi  there, yo" });
          expect(worker.load).toHaveBeenCalledWith(
            expect.objectContaining({
              libraryPath: `${where.runtime}/${LIBRARY}`,
              modelPath: `${where.models}/lantern-f16.gguf`,
              backend: "vulkan",
            }),
          );
          expect(worker.speak).toHaveBeenLastCalledWith({
            text: "Hi  there, yo",
            language: "en",
            options: { speed: "1.1", voice_id: "slate" },
          });
          expect(speech).toMatchObject({
            sampleRate: 24_000,
            timing: "estimated",
            words: [
              { start: 0, end: 2, t0Ms: 0, t1Ms: 200 },
              { start: 4, end: 10, t0Ms: 200, t1Ms: 800 },
              { start: 11, end: 13, t0Ms: 800, t1Ms: 1000 },
            ],
          });
          expect(speech.pcm.byteLength).toBe(48_000);

          // A request may name another voice, as a sample does, without changing the choice.
          yield* voices.speak({ text: "Sample.", modelId: "lantern", voiceId: "amber" });
          expect(worker.speak).toHaveBeenLastCalledWith(
            expect.objectContaining({ options: { speed: "1.1", voice_id: "amber" } }),
          );
          expect(worker.load).toHaveBeenCalledOnce();
          expect(
            yield* Effect.flip(voices.speak({ text: "Half.", modelId: "lantern" })),
          ).toMatchObject({ reason: "unknown-voice" });
        }).pipe(Effect.provide(layer));
        expect(worker.dispose).toHaveBeenCalledOnce();

        yield* Effect.gen(function* () {
          const voices = yield* VoiceOutput.VoiceOutput;
          expect((yield* voices.catalog).selection).toEqual({
            modelId: "lantern",
            voiceId: "slate",
          });
          const removed = yield* voices.remove("lantern");
          expect(removed).toMatchObject({
            selection: null,
            runtime: { state: "missing" },
            models: [{ install: { state: "downloadable" } }],
          });
          expect(yield* fs.exists(where.selection)).toBe(false);
          expect(yield* listing(where.models)).toEqual([]);
          expect(yield* listing(where.runtime)).toEqual([]);
          expect(yield* Effect.flip(voices.speak({ text: "Hello." }))).toMatchObject({
            reason: "no-voice-selected",
          });
        }).pipe(Effect.provide(layer));
      }),
    ).pipe(Effect.provide(dependencies)),
);

it.effect("unloads the worker after ten idle minutes and loads it again on demand", () =>
  run(
    Effect.gen(function* () {
      const voices = yield* VoiceOutput.VoiceOutput;
      yield* voices.download("lantern");
      const request = { text: "Hello.", modelId: "lantern", voiceId: "amber" };
      yield* voices.speak(request);
      yield* TestClock.adjust(10 * 60_000 - 1);
      expect(worker.dispose).not.toHaveBeenCalled();
      yield* TestClock.adjust(1);
      expect(worker.dispose).toHaveBeenCalledOnce();
      yield* voices.speak(request);
      expect(worker.load).toHaveBeenCalledTimes(2);
    }),
  ),
);

it.effect("kills the worker when a request is cancelled, and reports a failed synthesis", () =>
  run(
    Effect.gen(function* () {
      const voices = yield* VoiceOutput.VoiceOutput;
      yield* voices.download("lantern");
      const request = { text: "Hello.", modelId: "lantern", voiceId: "amber" };
      const speaking = yield* Deferred.make<void>();
      worker.speak.mockImplementationOnce(() => {
        Deferred.doneUnsafe(speaking, Effect.void);
        return new Promise(() => {});
      });
      const stuck = yield* voices.speak(request).pipe(Effect.forkChild);
      yield* Deferred.await(speaking);
      yield* Fiber.interrupt(stuck);
      expect(worker.dispose).toHaveBeenCalledOnce();

      worker.speak.mockRejectedValueOnce(new Error("native failure"));
      expect(yield* Effect.flip(voices.speak(request))).toMatchObject({ reason: "synthesis" });
      expect(worker.load).toHaveBeenCalledTimes(2);
      expect(yield* Effect.flip(voices.speak({ ...request, text: "   " }))).toMatchObject({
        reason: "synthesis",
      });
    }),
  ),
);
