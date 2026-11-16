import type * as Koffi from "koffi";

export type AudioCppSpeechRequest = {
  readonly text: string;
  /** Omit when the model should pick its own language. */
  readonly language?: string;
  /** Request options the model declares, such as `voice_id` or `speed`. */
  readonly options?: Readonly<Record<string, string>>;
};

export type AudioCppSpeechModel = {
  readonly backend: string;
  /** Speaks the whole text and returns its interleaved samples in [-1, 1]. */
  readonly speak: (request: AudioCppSpeechRequest) => {
    readonly samples: Float32Array;
    readonly sampleRate: number;
    readonly channels: number;
  };
};

/**
 * Binds what speech needs of audio.cpp's C ABI (`include/audiocpp.h`, ABI 0.4). The worker inlines
 * it with `toString()`, so it references nothing from module scope. Calls block the thread.
 * No test here loads the library, so this file is checked only against the header.
 */
export function bindAudioCpp(koffi: typeof Koffi, libraryPath: string) {
  const lib = koffi.load(libraryPath);
  const Registry = koffi.pointer(koffi.opaque());
  const Model = koffi.pointer(koffi.opaque());
  const Session = koffi.pointer(koffi.opaque());
  const Request = koffi.pointer(koffi.opaque());
  const Result = koffi.pointer(koffi.opaque());
  const Event = koffi.pointer(koffi.opaque());
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
    sessionCreate: lib.func("audiocpp_session_create", "int", [
      Model,
      "const char *",
      "const char *",
      koffi.pointer(BackendConfig),
      "void *",
      out(Session),
    ]),
    streamStart: lib.func("audiocpp_stream_start", "int", [Session, Request]),
    streamNextEvent: lib.func("audiocpp_stream_next_event", "int", [Session, out(Event)]),
    streamReset: lib.func("audiocpp_stream_reset", "int", [Session]),
    eventFree: lib.func("audiocpp_event_free", "void", [Event]),
    eventAsResult: lib.func("audiocpp_event_as_result", Result, [Event]),
    namedAudio: lib.func("audiocpp_result_named_audio", "int", [
      Result,
      "size_t",
      out("const char *"),
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
      native.sessionCreate(
        model,
        "tts",
        "streaming",
        { backend, device: 0, threads },
        null,
        session,
      ),
      `${backend} session creation`,
    );
    return session[0];
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
      try {
        if (!native.modelSupports(model, "tts", "streaming"))
          throw new Error("This model does not support streaming text to speech.");
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
        speak({ text, language, options = {} }) {
          const request = native.requestCreate();
          if (!request) throw new Error("audio.cpp could not allocate a request.");
          try {
            check(native.requestSetText(request, text, language ?? null), "request text");
            for (const [key, value] of Object.entries(options))
              check(native.requestSetOption(request, key, value), `request option ${key}`);
            // Starting copies the request into the session, so it can be freed right away.
            check(native.streamStart(session, request), "stream start");
          } finally {
            native.requestFree(request);
          }
          const chunks: Float32Array[] = [];
          let rate = 0;
          let channelCount = 0;
          try {
            for (;;) {
              const event: [unknown] = [null];
              check(native.streamNextEvent(session, event), "synthesis");
              // An empty queue ends the text; it is not an error.
              if (!event[0]) break;
              try {
                const id: [string] = [""];
                const samples: [unknown] = [null];
                const frames: [number | bigint] = [0];
                const sampleRate: [number] = [0];
                const channels: [number] = [0];
                check(
                  native.namedAudio(
                    native.eventAsResult(event[0]),
                    0,
                    id,
                    samples,
                    frames,
                    sampleRate,
                    channels,
                  ),
                  "audio read",
                );
                const length = Number(frames[0]) * channels[0];
                if (!length) continue;
                if (rate && (rate !== sampleRate[0] || channelCount !== channels[0]))
                  throw new Error("audio.cpp changed the audio format inside one request.");
                rate = sampleRate[0];
                channelCount = channels[0];
                // The view borrows event memory, so copy it before the event is freed.
                const copy = new Float32Array(length);
                copy.set(new Float32Array(koffi.view(samples[0], length * 4)));
                chunks.push(copy);
              } finally {
                native.eventFree(event[0]);
              }
            }
          } finally {
            native.streamReset(session);
          }
          if (!rate) throw new Error("audio.cpp produced no audio.");
          const all = new Float32Array(chunks.reduce((size, chunk) => size + chunk.length, 0));
          let offset = 0;
          for (const chunk of chunks) {
            all.set(chunk, offset);
            offset += chunk.length;
          }
          return { samples: all, sampleRate: rate, channels: channelCount };
        },
      };
    },
  };
}
