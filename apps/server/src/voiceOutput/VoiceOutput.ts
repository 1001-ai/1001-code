// @effect-diagnostics nodeBuiltinImport:off - worker parallelism comes from the host's CPU count.
import * as NodeOS from "node:os";
import {
  VOICE_OUTPUT_CATALOG_FILE,
  VoiceOutputError,
  type VoiceOutputCatalog,
  type VoiceOutputSelection,
  type VoiceOutputSpeakRequest,
  type VoiceOutputSpeech,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import { SPEECH_MODELS } from "../speech/model.ts";
import { SILERO_VAD } from "../speech/silero.ts";
import * as SpeechModelStore from "../speech/SpeechModelStore.ts";
import * as TeamCatalog from "../teamCatalog/TeamCatalog.ts";
import { makeRuntimeArchiveExtractor } from "./runtimeArchive.ts";
import { AUDIO_CPP_VERSION, GlibcVersion, RuntimeBuilds, voiceOutputRuntime } from "./runtime.ts";
import { estimateWordTimings } from "./speechAudio.ts";
import { decodeVoiceCatalogFile, type VoiceModel } from "./voiceCatalogFile.ts";
import { loadVoiceOutputModel, type VoiceOutputWorkerModel } from "./worker.ts";

const IDLE_UNLOAD_MS = 10 * 60_000;
const CATALOG_STALE_AFTER_MS = 10 * 60_000;

/** Dictation's files share the model folder; a voice file may not take one of their names. */
const RESERVED_FILENAMES: ReadonlySet<string> = new Set(
  [...SPEECH_MODELS, SILERO_VAD].map((model) => model.filename.split("/").at(-1)!),
);

const SelectionFile = Schema.fromJsonString(
  Schema.Struct({ modelId: Schema.String, voiceId: Schema.String }),
);
const decodeSelection = Schema.decodeUnknownOption(SelectionFile);
const encodeSelection = Schema.encodeSync(SelectionFile);

export class VoiceOutputStateError extends Schema.TaggedError<VoiceOutputStateError>()(
  "VoiceOutputStateError",
  { operation: Schema.Literals(["select", "remove"]), cause: Schema.Defect() },
) {
  override get message(): string {
    return `Could not ${this.operation} the voice on disk.`;
  }
}

class VoiceOutputWorkerError extends Schema.TaggedError<VoiceOutputWorkerError>()(
  "VoiceOutputWorkerError",
  { stage: Schema.Literals(["load", "speak"]), cause: Schema.Defect() },
) {
  override get message(): string {
    return `The voice worker failed to ${this.stage}.`;
  }
}

/**
 * Speech output with voice models the user downloads. Synthesis runs on this machine in a worker
 * process; the only network traffic is the downloads the user starts.
 */
export class VoiceOutput extends Context.Service<
  VoiceOutput,
  {
    readonly catalog: Effect.Effect<VoiceOutputCatalog>;
    /** Resolves when the install finishes or is cancelled; poll `catalog` for progress. */
    readonly download: (modelId: string) => Effect.Effect<VoiceOutputCatalog, VoiceOutputError>;
    readonly cancel: (modelId: string) => Effect.Effect<VoiceOutputCatalog>;
    /** Removes the model, and the shared runtime once no installed model needs it. */
    readonly remove: (
      modelId: string,
    ) => Effect.Effect<VoiceOutputCatalog, VoiceOutputError | VoiceOutputStateError>;
    readonly select: (
      selection: VoiceOutputSelection,
    ) => Effect.Effect<VoiceOutputCatalog, VoiceOutputError | VoiceOutputStateError>;
    /** One sentence per call. Interrupting it kills the worker, which the next call starts again. */
    readonly speak: (
      request: VoiceOutputSpeakRequest,
    ) => Effect.Effect<VoiceOutputSpeech, VoiceOutputError>;
  }
>()("t3/voiceOutput/VoiceOutput") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const store = yield* SpeechModelStore.SpeechModelStore;
  const teamCatalog = yield* TeamCatalog.TeamCatalog;
  const config = yield* ServerConfig.ServerConfig;
  const scope = yield* Effect.scope;
  const extractRuntimeArchive = yield* makeRuntimeArchiveExtractor;
  const platform = yield* HostProcess.Platform;
  const architecture = yield* HostProcess.Architecture;
  const { runtime, error: unsupported } = voiceOutputRuntime(
    {
      platform,
      architecture,
      libc: platform === "linux" ? yield* HostProcess.LinuxLibc : undefined,
      glibc: platform === "linux" ? yield* GlibcVersion : undefined,
    },
    yield* RuntimeBuilds,
  );
  const runtimeFile = runtime && {
    id: "pingdotgg/audio.cpp",
    revision: AUDIO_CPP_VERSION,
    filename: runtime.filename,
    url: runtime.url,
    size: runtime.size,
    sha256: runtime.sha256,
  };
  // Upstream T3 Code's local read-aloud installs the same runtime to the same folder.
  const runtimeDirectory = path.join(
    config.stateDir,
    "speech",
    "runtime",
    `audio-cpp-${AUDIO_CPP_VERSION}-${platform}-${architecture}`,
  );
  const libraryPath = runtime && path.join(runtimeDirectory, runtime.library);
  const completeMarker = path.join(runtimeDirectory, ".t3-complete");
  const selectionPath = path.join(config.stateDir, "voice-output", "selection.json");

  const runtimeReady = Effect.gen(function* () {
    if (!libraryPath) return false;
    return (yield* fs.exists(completeMarker)) && (yield* fs.exists(libraryPath));
  }).pipe(Effect.orElseSucceed(() => false));

  let lastCatalogRefreshMs = 0;
  // Never waits for git: a stale catalog is refreshed in the background for the next read.
  const refreshWhenStale = Effect.fn("VoiceOutput.refreshWhenStale")(function* () {
    const snapshot = yield* teamCatalog.snapshot;
    if (snapshot.source === null || snapshot.refreshing) return snapshot;
    const now = yield* Clock.currentTimeMillis;
    const fetchedAt = snapshot.fetchedAt === null ? 0 : Date.parse(snapshot.fetchedAt);
    if (
      now - fetchedAt >= CATALOG_STALE_AFTER_MS &&
      now - lastCatalogRefreshMs >= CATALOG_STALE_AFTER_MS
    ) {
      lastCatalogRefreshMs = now;
      yield* teamCatalog.refresh().pipe(Effect.forkIn(scope));
    }
    return snapshot;
  });

  type VoiceList = {
    readonly models: ReadonlyArray<VoiceModel>;
    readonly unavailable: VoiceOutputCatalog["unavailable"];
  };
  const readList: Effect.Effect<VoiceList> = Effect.gen(function* () {
    const none = (
      reason: NonNullable<VoiceOutputCatalog["unavailable"]>["reason"],
      message: string,
    ) => ({ models: [], unavailable: { reason, message } });
    if (unsupported) return none("unsupported-platform", unsupported);
    const snapshot = yield* refreshWhenStale();
    if (snapshot.source === null)
      return none(
        "no-team-catalog",
        "Voices come from the team catalog, and this environment has none set.",
      );
    const text = yield* teamCatalog.readFile(VOICE_OUTPUT_CATALOG_FILE);
    if (text === null)
      return none(
        "no-voices-file",
        snapshot.fetchedAt === null
          ? "The team catalog has not been fetched yet. Try again in a moment."
          : `The team catalog has no ${VOICE_OUTPUT_CATALOG_FILE}.`,
      );
    const decoded = decodeVoiceCatalogFile(text, RESERVED_FILENAMES);
    if (typeof decoded === "string")
      return none(
        "invalid-voices-file",
        `The team catalog's ${VOICE_OUTPUT_CATALOG_FILE} is not valid: ${decoded}`,
      );
    return { models: decoded, unavailable: null };
  });

  let selection: VoiceOutputSelection | null = yield* fs.readFileString(selectionPath).pipe(
    Effect.map((text) => decodeSelection(text)),
    Effect.map((decoded) => (decoded._tag === "Some" ? decoded.value : null)),
    Effect.orElseSucceed(() => null),
  );
  const writeSelection = Effect.fn("VoiceOutput.writeSelection")(function* (
    next: VoiceOutputSelection | null,
  ) {
    if (next === null) yield* fs.remove(selectionPath, { force: true });
    else {
      yield* fs.makeDirectory(path.dirname(selectionPath), { recursive: true });
      yield* fs.writeFileString(selectionPath, encodeSelection(next), { mode: 0o600 });
    }
    selection = next;
  });
  const findVoice = (models: ReadonlyArray<VoiceModel>, chosen: VoiceOutputSelection | null) => {
    const model = models.find((entry) => entry.id === chosen?.modelId);
    const voice = model?.voices.find((entry) => entry.id === chosen?.voiceId);
    return model && voice ? { model, voice } : undefined;
  };

  type Transfer = {
    readonly modelId: string;
    /** Fixed once the install knows whether it needs the runtime, so extracting it does not shrink it. */
    size: number;
    runtime: number;
    model: number;
    verifying: boolean;
    fiber?: Fiber.Fiber<void, VoiceOutputError>;
  };
  let transfer: Transfer | undefined;
  // A removal deletes the shared runtime, so it and an install must not overlap.
  let removing = false;
  // Why each model's last install stopped; a download request may be gone before it does.
  const failures = new Map<string, "verification" | "download">();

  const catalogOf = Effect.fn("VoiceOutput.catalog")(function* (list: VoiceList) {
    const ready = yield* runtimeReady;
    const runtimeSize = ready || !runtimeFile ? 0 : runtimeFile.size;
    const models = yield* Effect.forEach(list.models, (model) =>
      Effect.gen(function* () {
        const active = transfer?.modelId === model.id ? transfer : undefined;
        const failure = failures.get(model.id);
        const install = active
          ? {
              state: active.verifying ? ("verifying" as const) : ("downloading" as const),
              size: active.size,
              downloaded: active.runtime + active.model,
            }
          : {
              state:
                ready && (yield* store.isReady(model.file))
                  ? ("installed" as const)
                  : ("downloadable" as const),
              size: model.file.size + runtimeSize,
              ...(failure ? { failure } : {}),
            };
        return {
          id: model.id,
          name: model.name,
          license: model.license,
          licenseUrl: model.licenseUrl,
          sampleText: model.sampleText,
          voices: model.voices,
          install,
        };
      }),
    );
    return {
      unavailable: list.unavailable,
      runtime: {
        state: !runtimeFile ? "unsupported" : ready ? "installed" : "missing",
        size: runtimeFile?.size ?? 0,
      },
      models,
      selection: findVoice(list.models, selection) ? selection : null,
    } satisfies VoiceOutputCatalog;
  });
  const catalog = readList.pipe(Effect.flatMap(catalogOf));

  const findModel = Effect.fn("VoiceOutput.findModel")(function* (modelId: string) {
    const list = yield* readList;
    if (list.unavailable) return yield* new VoiceOutputError({ reason: "unavailable" });
    const model = list.models.find((entry) => entry.id === modelId);
    if (!model) return yield* new VoiceOutputError({ reason: "unknown-voice" });
    return { model, list };
  });

  // Publishes the transfer before forking: a cached file can finish before forkIn returns.
  const reserve = Effect.fn("VoiceOutput.reserve")(function* (modelId: string) {
    const { model } = yield* findModel(modelId);
    if (!runtimeFile || !runtime) return yield* new VoiceOutputError({ reason: "unavailable" });
    // Checked and claimed without yielding, so a concurrent download or removal cannot interleave.
    if (removing || (transfer && transfer.modelId !== modelId))
      return yield* new VoiceOutputError({ reason: "busy" });
    if (!transfer) {
      const state: Transfer = {
        modelId,
        size: model.file.size,
        runtime: 0,
        model: 0,
        verifying: false,
      };
      transfer = state;
      failures.delete(modelId);
      const install = Effect.gen(function* () {
        // Read after claiming: no removal can start while this transfer exists.
        if (!(yield* runtimeReady)) {
          state.size += runtimeFile.size;
          const archivePath = yield* store.download(runtimeFile, {
            onProgress: (downloaded) => {
              state.runtime = downloaded;
              state.verifying = false;
            },
            onVerificationStart: () => {
              state.verifying = true;
            },
          });
          state.verifying = true;
          yield* extractRuntimeArchive({
            archivePath,
            destination: runtimeDirectory,
            library: runtime.library,
            version: AUDIO_CPP_VERSION,
          }).pipe(
            // The archive is only a transfer; the extracted folder is the install.
            Effect.ensuring(store.remove(runtimeFile).pipe(Effect.ignore)),
          );
          state.runtime = runtimeFile.size;
        }
        state.verifying = false;
        yield* store.download(model.file, {
          onProgress: (downloaded) => {
            state.model = downloaded;
            state.verifying = false;
          },
          onVerificationStart: () => {
            state.verifying = true;
          },
        });
      }).pipe(
        Effect.tapError((error) =>
          Effect.logWarning("A voice model install failed.", { modelId, error }),
        ),
        Effect.mapError((error) => {
          const reason =
            error._tag === "RuntimeArchiveError" ||
            (error._tag === "SpeechModelDownloadError" && error.reason === "verification")
              ? ("verification" as const)
              : ("download" as const);
          failures.set(modelId, reason);
          return new VoiceOutputError({ reason });
        }),
      );
      // Owned by the service, so a dropped request does not abandon a large download.
      state.fiber = yield* install.pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (transfer === state) transfer = undefined;
          }),
        ),
        Effect.forkIn(scope),
      );
    }
    return transfer.fiber!;
  }, Effect.uninterruptible);

  const download = Effect.fn("VoiceOutput.download")(function* (modelId: string) {
    const exit = yield* Fiber.await(yield* reserve(modelId));
    const failure = failures.get(modelId);
    if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause))
      return yield* new VoiceOutputError({ reason: failure ?? "download" });
    return yield* catalog;
  });

  const cancel = Effect.fn("VoiceOutput.cancel")(function* (modelId: string) {
    const fiber = transfer?.modelId === modelId ? transfer.fiber : undefined;
    if (fiber) yield* Fiber.interrupt(fiber);
    return yield* catalog;
  });

  // One native request at a time; the worker process holds a single loaded model.
  const permit = yield* Semaphore.make(1);
  let worker: { readonly modelId: string; readonly model: VoiceOutputWorkerModel } | undefined;
  // @effect-diagnostics-next-line abortControllerInEffect:off - The cached worker must also stop on service shutdown.
  const lifetime = new AbortController();
  const unloadWorker = Effect.promise(async () => {
    const current = worker;
    worker = undefined;
    await current?.model.dispose();
  });
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => lifetime.abort()).pipe(Effect.andThen(unloadWorker)),
  );
  const idleDeadlines = yield* Queue.sliding<void>(1);
  yield* Stream.fromQueue(idleDeadlines).pipe(
    Stream.switchMap(() =>
      Stream.fromEffect(
        Effect.sleep(IDLE_UNLOAD_MS).pipe(Effect.andThen(permit.withPermits(1)(unloadWorker))),
      ),
    ),
    Stream.runDrain,
    Effect.forkScoped,
  );

  const remove = Effect.fn("VoiceOutput.remove")(function* (modelId: string) {
    const { model, list } = yield* findModel(modelId);
    yield* Effect.acquireUseRelease(
      Effect.suspend(() => {
        if (transfer || removing) return new VoiceOutputError({ reason: "busy" });
        removing = true;
        return Effect.void;
      }),
      () =>
        permit.withPermits(1)(
          Effect.gen(function* () {
            if (worker?.modelId === modelId) yield* unloadWorker;
            yield* store.remove(model.file);
            failures.delete(modelId);
            if (selection?.modelId === modelId) yield* writeSelection(null);
            const remaining = yield* Effect.filter(list.models, (entry) =>
              store.isReady(entry.file),
            );
            if (remaining.length === 0) {
              yield* unloadWorker;
              yield* fs.remove(runtimeDirectory, { recursive: true, force: true });
            }
          }).pipe(
            Effect.mapError((cause) => new VoiceOutputStateError({ operation: "remove", cause })),
          ),
        ),
      () =>
        Effect.sync(() => {
          removing = false;
        }),
    );
    return yield* catalog;
  });

  const select = Effect.fn("VoiceOutput.select")(function* (next: VoiceOutputSelection) {
    const { model, list } = yield* findModel(next.modelId);
    if (!findVoice(list.models, next))
      return yield* new VoiceOutputError({ reason: "unknown-voice" });
    if (!((yield* runtimeReady) && (yield* store.isReady(model.file))))
      return yield* new VoiceOutputError({ reason: "not-installed" });
    yield* writeSelection(next).pipe(
      Effect.mapError((cause) => new VoiceOutputStateError({ operation: "select", cause })),
    );
    return yield* catalogOf(list);
  });

  const speak = Effect.fn("VoiceOutput.speak")(function* (request: VoiceOutputSpeakRequest) {
    if (!runtime || !libraryPath) return yield* new VoiceOutputError({ reason: "unavailable" });
    const list = yield* readList;
    if (list.unavailable) return yield* new VoiceOutputError({ reason: "unavailable" });
    const named = request.modelId !== undefined || request.voiceId !== undefined;
    const chosen = named
      ? request.modelId !== undefined && request.voiceId !== undefined
        ? { modelId: request.modelId, voiceId: request.voiceId }
        : null
      : selection;
    const found = findVoice(list.models, chosen);
    if (!found)
      return yield* new VoiceOutputError({
        reason: named || chosen ? "unknown-voice" : "no-voice-selected",
      });
    const { model, voice } = found;
    if (request.text.trim().length === 0)
      return yield* new VoiceOutputError({ reason: "synthesis" });
    if (!(yield* runtimeReady)) return yield* new VoiceOutputError({ reason: "not-installed" });
    const modelPath = yield* store.installedPath(model.file);
    if (!modelPath) return yield* new VoiceOutputError({ reason: "not-installed" });
    const synthesisFailed = (cause: unknown) =>
      Effect.logWarning("Voice output failed.", { modelId: model.id, cause }).pipe(
        Effect.andThen(Effect.fail(new VoiceOutputError({ reason: "synthesis" }))),
      );
    const audio = yield* permit
      .withPermits(1)(
        Effect.gen(function* () {
          if (!worker?.model.alive || worker.modelId !== model.id) {
            yield* unloadWorker;
            // Uninterruptible, so a request stopped mid-load still records the process it started.
            yield* Effect.tryPromise({
              try: () =>
                loadVoiceOutputModel({
                  libraryPath,
                  backend: runtime.backend,
                  modelPath,
                  threads: Math.max(1, Math.min(8, NodeOS.availableParallelism() - 1)),
                  signal: lifetime.signal,
                }),
              catch: (cause) => new VoiceOutputWorkerError({ stage: "load", cause }),
            }).pipe(
              Effect.tap((loaded) =>
                Effect.sync(() => {
                  worker = { modelId: model.id, model: loaded };
                }),
              ),
              Effect.uninterruptible,
            );
          }
          const current = worker!.model;
          return yield* Effect.tryPromise({
            try: () =>
              current.speak({
                text: request.text,
                ...(model.language ? { language: model.language } : {}),
                options: { ...model.requestOptions, voice_id: voice.id },
              }),
            catch: (cause) => new VoiceOutputWorkerError({ stage: "speak", cause }),
          }).pipe(
            // Native synthesis cannot be asked to stop, so a cancelled request kills its process.
            Effect.onInterrupt(() => unloadWorker),
          );
        }),
      )
      .pipe(
        Effect.catch(synthesisFailed),
        Effect.ensuring(Effect.sync(() => Queue.offerUnsafe(idleDeadlines, undefined))),
      );
    if (audio.pcm.byteLength === 0 || audio.pcm.byteLength % 2 !== 0)
      return yield* synthesisFailed("The worker returned no audio.");
    const durationMs = (audio.pcm.byteLength / 2 / audio.sampleRate) * 1000;
    return {
      sampleRate: audio.sampleRate,
      timing: "estimated" as const,
      words: estimateWordTimings(request.text, durationMs),
      pcm: audio.pcm,
    };
  });

  return VoiceOutput.of({ catalog, download, cancel, remove, select, speak });
});

export const layer = Layer.effect(VoiceOutput, make);
