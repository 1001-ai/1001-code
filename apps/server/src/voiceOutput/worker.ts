// @effect-diagnostics nodeBuiltinImport:off - native inference and IPC cleanup need killable Promise boundaries outside the Effect runtime.
import * as NodeChildProcess from "node:child_process";
import * as NodeSea from "node:sea";

import { bindAudioCpp, type AudioCppSpeechRequest } from "./audioCppBindings.ts";
import { pcm16Mono } from "./speechAudio.ts";

// Inlined like the dictation worker, so packaged builds need no separate worker artifact.
const entry = `
  const { createRequire, findPackageJSON } = await import("node:module");
  const { dirname } = await import("node:path");
  const bindAudioCpp = ${bindAudioCpp.toString()};
  const pcm16Mono = ${pcm16Mono.toString()};
  let model;
  const reply = (message) => process.send({ type: "t3-voice-output-reply", ...message });
  process.on("message", async (message) => {
    try {
      if (message.kind === "load") {
        let bind = bindAudioCpp;
        let koffi;
        if (message.bindingsUrl) bind = (await import(message.bindingsUrl)).bindAudioCpp;
        else {
          const koffiPath = findPackageJSON("koffi", baseUrl);
          if (!koffiPath) throw new Error("The koffi package is unavailable.");
          koffi = createRequire(koffiPath)(dirname(koffiPath));
        }
        model = bind(koffi, message.libraryPath).loadSpeechModel(message.modelPath, {
          backend: message.backend, threads: message.threads,
        });
        reply({ ok: true, backend: model.backend });
      } else if (message.kind === "speak") {
        const audio = model.speak(message.request);
        const pcm = pcm16Mono(audio.samples, audio.channels);
        reply({
          ok: true,
          sampleRate: audio.sampleRate,
          pcm: new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength),
        });
      }
    } catch (error) {
      reply({ ok: false, error: error instanceof Error ? error.stack ?? error.message : String(error) });
    }
  });
  // Exit teardown under in-flight native inference can crash, so terminate without it.
  process.on("disconnect", () => process.kill(process.pid, "SIGKILL"));
`;

export async function runVoiceOutputWorker() {
  if (!process.send) throw new Error("Speech workers require an IPC channel.");
  const run = new Function("baseUrl", `return (async () => {${entry}})();`) as (
    baseUrl: string,
  ) => Promise<void>;
  await run(import.meta.url);
}

const workerArgs = () =>
  NodeSea.isSea()
    ? ["__speech-worker", "voice-output"]
    : ["--input-type=module", "-e", `const baseUrl = ${JSON.stringify(import.meta.url)};${entry}`];

const WORKER_ENVIRONMENT_NAMES = [
  "PATH",
  "HOME",
  "USERPROFILE",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "SystemRoot",
  "windir",
];

/**
 * The worker runs a prebuilt native library, so it gets only what a process needs to start and
 * find system libraries: never the server's tokens, keys or other `T3CODE_*` settings.
 */
export function voiceOutputWorkerEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ELECTRON_RUN_AS_NODE: "1" };
  for (const name of WORKER_ENVIRONMENT_NAMES) {
    const value = source[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}

type Reply = {
  readonly type: "t3-voice-output-reply";
  readonly ok: boolean;
  readonly error?: string;
  readonly backend?: string;
  readonly sampleRate?: unknown;
  readonly pcm?: unknown;
};

export type VoiceOutputWorkerModel = Awaited<ReturnType<typeof loadVoiceOutputModel>>;

/** Loads a model in an isolated process; aborting `signal` kills it, even mid-synthesis. */
export async function loadVoiceOutputModel(options: {
  readonly libraryPath: string;
  /** Falls back to the CPU when the backend has no device here. */
  readonly backend: string;
  readonly modelPath: string;
  readonly threads: number;
  readonly signal: AbortSignal;
  /** Tests only: a module whose `bindAudioCpp` stands in for the real library. */
  readonly bindingsUrl?: string;
}) {
  options.signal.throwIfAborted();
  const child = NodeChildProcess.spawn(process.execPath, workerArgs(), {
    stdio: ["ignore", "ignore", "inherit", "ipc"],
    serialization: "advanced",
    env: voiceOutputWorkerEnvironment(process.env),
  });
  let alive = true;
  let pending: ReturnType<typeof Promise.withResolvers<Reply>> | undefined;
  const exited = Promise.withResolvers<void>();
  const fail = (error: Error) => {
    alive = false;
    pending?.reject(error);
    pending = undefined;
  };
  child.on("error", (error) => {
    fail(error);
    exited.resolve();
  });
  child.on("exit", (code, exitSignal) => {
    fail(new Error(`Voice output process exited (${exitSignal ?? code}).`));
    options.signal.removeEventListener("abort", stop);
    exited.resolve();
  });
  child.on("message", (message: unknown) => {
    if (
      typeof message !== "object" ||
      message === null ||
      !("type" in message) ||
      message.type !== "t3-voice-output-reply"
    )
      return;
    const reply = message as Reply;
    const request = pending;
    pending = undefined;
    if (reply.ok) request?.resolve(reply);
    else request?.reject(new Error(reply.error ?? "Voice output failed."));
  });
  function stop() {
    fail(new Error("Voice output process stopped."));
    // Never call native dispose while inference is active. The OS owns cleanup of the isolated process.
    child.kill("SIGKILL");
  }
  options.signal.addEventListener("abort", stop, { once: true });
  const send = (message: object) => {
    if (!alive) return Promise.reject(new Error("Voice output process stopped."));
    if (pending) return Promise.reject(new Error("Voice output process is busy."));
    const request = Promise.withResolvers<Reply>();
    pending = request;
    child.send(message, (error) => {
      if (error) {
        request.reject(error);
        if (pending === request) pending = undefined;
      }
    });
    return request.promise;
  };
  const dispose = async () => {
    stop();
    await exited.promise;
  };
  let loaded: Reply;
  try {
    loaded = await send({
      kind: "load",
      libraryPath: options.libraryPath,
      backend: options.backend,
      modelPath: options.modelPath,
      threads: options.threads,
      bindingsUrl: options.bindingsUrl,
    });
  } catch (error) {
    await dispose();
    throw error;
  }
  return {
    backend: loaded.backend ?? "unknown",
    get alive() {
      return alive;
    },
    /** One request at a time. Little-endian 16-bit mono PCM at the model's sample rate. */
    speak: async (request: AudioCppSpeechRequest) => {
      const reply = await send({ kind: "speak", request });
      if (typeof reply.sampleRate !== "number" || !(reply.pcm instanceof Uint8Array))
        throw new Error("Invalid voice output response.");
      return { sampleRate: reply.sampleRate, pcm: reply.pcm };
    },
    dispose,
  };
}
