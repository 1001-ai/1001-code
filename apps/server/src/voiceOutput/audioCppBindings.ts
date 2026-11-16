import type * as Koffi from "koffi";

export type AudioCppSpeechRequest = {
  readonly text: string;
  /** Omit when the model should pick its own language. Some models refuse a language. */
  readonly language?: string;
  /** Sent as the request option `voice_id`, but only to a model that declares that option. */
  readonly voiceId?: string;
  /** Request options the model declares, such as `speed`. Some models refuse any other. */
  readonly options?: Readonly<Record<string, string>>;
};

export type AudioCppSpeechModel = {
  readonly backend: string;
  /** Speaks the whole text and returns its interleaved samples, nominally in [-1, 1]. */
  readonly speak: (request: AudioCppSpeechRequest) => {
    readonly samples: Float32Array;
    readonly sampleRate: number;
    readonly channels: number;
  };
};

/**
 * Binds what speech needs of audio.cpp's C ABI (`include/audiocpp.h`, ABI 0.4). The worker inlines
 * it with `toString()`, so it references nothing from module scope. Calls block the thread.
 * It speaks with one offline run: streaming sessions deliver audio in three different ways, and
 * some models refuse them. Tests here use a stand-in for koffi; see fork/README.md for the real check.
 */
export function bindAudioCpp(koffi: typeof Koffi, libraryPath: string) {
  const lib = koffi.load(libraryPath);
  const Registry = koffi.pointer(koffi.opaque());
  const Model = koffi.pointer(koffi.opaque());
  const Session = koffi.pointer(koffi.opaque());
  const Request = koffi.pointer(koffi.opaque());
  const Result = koffi.pointer(koffi.opaque());
  const BackendConfig = koffi.struct({ backend: "const char *", device: "int", threads: "int" });
  const out = (type: string | Koffi.TypeObject) => koffi.out(koffi.pointer(type));
  const native = {
    abiVersion: lib.func("audiocpp_abi_version", "uint32_t", []),
    lastError: lib.func("audiocpp_last_error", "const char *", []),
    statusString: lib.func("audiocpp_status_string", "const char *", ["int"]),
    registryCreate: lib.func("audiocpp_registry_create", "int", ["const char *", out(Registry)]),
    modelLoad: lib.func("audiocpp_model_load", "int", [
      Registry,
      "const char *",
      "void *",
      "void *",
      out(Model),
    ]),
    modelFree: lib.func("audiocpp_model_free", "void", [Model]),
    modelSupports: lib.func("audiocpp_model_supports", "int", [
      Model,
      "const char *",
      "const char *",
    ]),
    modelOptionCount: lib.func("audiocpp_model_option_count", "size_t", [Model, "int"]),
    // Only the name is read; the six outputs after it are optional and passed as null.
    modelOption: lib.func("audiocpp_model_option", "int", [
      Model,
      "int",
      "size_t",
      out("const char *"),
      "void *",
      "void *",
      "void *",
      "void *",
      "void *",
      "void *",
    ]),
    sessionCreate: lib.func("audiocpp_session_create", "int", [
      Model,
      "const char *",
      "const char *",
      koffi.pointer(BackendConfig),
      "void *",
      out(Session),
    ]),
    sessionRun: lib.func("audiocpp_session_run", "int", [Session, Request, out(Result)]),
    resultFree: lib.func("audiocpp_result_free", "void", [Result]),
    resultAudio: lib.func("audiocpp_result_audio", "int", [
      Result,
      out("void *"),
      out("size_t"),
      out("int"),
      out("int"),
    ]),
    requestCreate: lib.func("audiocpp_request_create", Request, []),
    requestFree: lib.func("audiocpp_request_free", "void", [Request]),
    requestSetText: lib.func("audiocpp_request_set_text", "int", [
      Request,
      "const char *",
      "const char *",
    ]),
    requestSetOption: lib.func("audiocpp_request_set_option", "int", [
      Request,
      "const char *",
      "const char *",
    ]),
  };
  // Refuse a library whose major ABI differs from the one these signatures describe.
  if (native.abiVersion() >>> 16 !== 0) throw new Error("Unsupported audio.cpp ABI version.");
  const check = (status: number, operation: string) => {
    if (status === 0) return;
    const detail = native.lastError();
    throw new Error(
      `audio.cpp ${operation} failed (${native.statusString(status)})${detail ? `: ${detail}` : ""}`,
    );
  };
  const registry: [unknown] = [null];
  check(native.registryCreate(null, registry), "registry creation");

  const openSession = (model: unknown, backend: string, threads: number) => {
    const session: [unknown] = [null];
    check(
      native.sessionCreate(model, "tts", "offline", { backend, device: 0, threads }, null, session),
      `${backend} session creation`,
    );
    return session[0];
  };

  // Scope 0 is the request scope (`AUDIOCPP_OPTION_SCOPE_REQUEST`).
  const declaresRequestOption = (model: unknown, wanted: string) => {
    const count = Number(native.modelOptionCount(model, 0));
    for (let index = 0; index < count; index++) {
      const name: [string | null] = [null];
      check(
        native.modelOption(model, 0, index, name, null, null, null, null, null, null),
        "option listing",
      );
      if (name[0] === wanted) return true;
    }
    return false;
  };

  return {
    /** Opens a text-to-speech session, falling back to the CPU when `backend` fails. */
    loadSpeechModel(
      path: string,
      { backend, threads }: { readonly backend: string; readonly threads: number },
    ): AudioCppSpeechModel {
      const loaded: [unknown] = [null];
      check(native.modelLoad(registry[0], path, null, null, loaded), "model load");
      const model = loaded[0];
      let session: unknown;
      let sessionBackend = backend;
      let choosesVoice: boolean;
      try {
        if (!native.modelSupports(model, "tts", "offline"))
          throw new Error("This model does not support text to speech.");
        // A model with one built-in voice declares no `voice_id`, and some refuse an unknown option.
        choosesVoice = declaresRequestOption(model, "voice_id");
        try {
          session = openSession(model, backend, threads);
        } catch (error) {
          if (backend === "cpu") throw error;
          sessionBackend = "cpu";
          session = openSession(model, "cpu", threads);
        }
      } catch (error) {
        native.modelFree(model);
        throw error;
      }
      return {
        backend: sessionBackend,
        speak({ text, language, voiceId, options = {} }) {
          const request = native.requestCreate();
          if (!request) throw new Error("audio.cpp could not allocate a request.");
          const result: [unknown] = [null];
          try {
            check(native.requestSetText(request, text, language ?? null), "request text");
            const sent =
              choosesVoice && voiceId !== undefined ? { ...options, voice_id: voiceId } : options;
            for (const [key, value] of Object.entries(sent))
              check(native.requestSetOption(request, key, value), `request option ${key}`);
            check(native.sessionRun(session, request, result), "synthesis");
          } finally {
            native.requestFree(request);
          }
          try {
            const samples: [unknown] = [null];
            const frames: [number | bigint] = [0];
            const sampleRate: [number] = [0];
            const channels: [number] = [0];
            check(
              native.resultAudio(result[0], samples, frames, sampleRate, channels),
              "audio read",
            );
            const length = Number(frames[0]) * channels[0];
            if (!length || !sampleRate[0]) throw new Error("audio.cpp produced no audio.");
            // Copies before the result is freed. Not `koffi.view`: Electron forbids external buffers.
            return {
              samples: koffi.decode(samples[0], "float", length) as Float32Array,
              sampleRate: sampleRate[0],
              channels: channels[0],
            };
          } finally {
            native.resultFree(result[0]);
          }
        },
      };
    },
  };
}
