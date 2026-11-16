import * as Schema from "effect/Schema";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import * as HttpApiSchema from "effect/http-api/HttpApiSchema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import type {
  EnvironmentAuthenticatedAuth,
  EnvironmentInternalError,
  EnvironmentRequestInvalidError,
  EnvironmentScopeRequiredError,
} from "./environmentHttp.ts";

/**
 * The voice models this app may download are data, not code: one file in the team catalog
 * repository. The app knows no voice by name.
 */
export const VOICE_OUTPUT_CATALOG_FILE = "voices/voices.json";

const VoiceOutputId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/));

const HUGGING_FACE_FILE_URL =
  /^https:\/\/huggingface\.co\/([A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*)\/resolve\/([0-9a-f]{40})\/((?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.gguf)$/;

/** The repository, commit and path a pinned Hugging Face file URL names; undefined for any other URL. */
export function parseVoiceOutputFileUrl(url: string) {
  const match = HUGGING_FACE_FILE_URL.exec(url);
  if (!match) return undefined;
  const [, repository, revision, path] = match;
  if (path!.split("/").some((segment) => segment === "." || segment === "..")) return undefined;
  return { repository: repository!, revision: revision!, path: path! };
}

const VoiceOutputFileUrl = Schema.String.check(
  Schema.isMaxLength(500),
  Schema.makeFilter((url) =>
    parseVoiceOutputFileUrl(url)
      ? true
      : "Must be https://huggingface.co/<owner>/<repo>/resolve/<40-character commit>/<path>.gguf.",
  ),
);

const VoiceOutputCatalogVoice = Schema.Struct({
  /**
   * Sent to the runtime as the request option `voice_id`. A model that declares no such option
   * has one built-in voice: list one entry, whose id only names it here.
   */
  id: VoiceOutputId,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(80)),
});

const VoiceOutputCatalogModel = Schema.Struct({
  id: VoiceOutputId,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(80)),
  license: TrimmedNonEmptyString.check(Schema.isMaxLength(80)),
  licenseUrl: Schema.String.check(
    Schema.isMaxLength(500),
    Schema.isPattern(/^https:\/\/[A-Za-z0-9.-]+\/[^\s]*$/),
  ),
  /** One self-contained model file, installed only after its size and SHA-256 match. */
  file: Schema.Struct({
    url: VoiceOutputFileUrl,
    size: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 8 * 1024 ** 3 })),
    sha256: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
  }),
  voices: Schema.Array(VoiceOutputCatalogVoice).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(64),
  ),
  /** What "Hear a sample" speaks. */
  sampleText: TrimmedNonEmptyString.check(Schema.isMaxLength(300)),
  /** The language given to the runtime with the text; omit to let the model choose. */
  language: Schema.optionalKey(
    Schema.String.check(Schema.isPattern(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/)),
  ),
  /** Extra request options the model declares, such as `speed`. */
  requestOptions: Schema.optionalKey(
    Schema.Record(
      Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9_]{0,39}$/)),
      Schema.String.check(Schema.isMaxLength(80)),
    ),
  ),
});
export type VoiceOutputCatalogModel = typeof VoiceOutputCatalogModel.Type;

export const VoiceOutputCatalogFile = Schema.Struct({
  version: Schema.Literal(1),
  models: Schema.Array(VoiceOutputCatalogModel).check(Schema.isMaxLength(32)),
});
export type VoiceOutputCatalogFile = typeof VoiceOutputCatalogFile.Type;

const VoiceOutputInstall = Schema.Struct({
  state: Schema.Literals(["downloadable", "downloading", "verifying", "installed"]),
  /** Bytes this install transfers: the model, plus the runtime while it is missing. */
  size: Schema.Finite,
  downloaded: Schema.optionalKey(Schema.Finite),
  /** Why the last install of this model stopped, until the next one starts. */
  failure: Schema.optionalKey(Schema.Literals(["verification", "download"])),
});

const VoiceOutputModel = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  license: Schema.String,
  licenseUrl: Schema.String,
  sampleText: Schema.String,
  voices: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String })),
  install: VoiceOutputInstall,
});
export type VoiceOutputModel = typeof VoiceOutputModel.Type;

const VoiceOutputSelection = Schema.Struct({ modelId: VoiceOutputId, voiceId: VoiceOutputId });
export type VoiceOutputSelection = typeof VoiceOutputSelection.Type;

export const VoiceOutputCatalog = Schema.Struct({
  /** Why no voice can be offered here; null when the list below is usable. */
  unavailable: Schema.NullOr(
    Schema.Struct({
      reason: Schema.Literals([
        "no-team-catalog",
        "no-voices-file",
        "invalid-voices-file",
        "unsupported-platform",
      ]),
      message: Schema.String,
    }),
  ),
  runtime: Schema.Struct({
    state: Schema.Literals(["unsupported", "missing", "installed"]),
    size: Schema.Finite,
  }),
  models: Schema.Array(VoiceOutputModel),
  /** The voice `speak` uses when a request names none; there is no default. */
  selection: Schema.NullOr(VoiceOutputSelection),
});
export type VoiceOutputCatalog = typeof VoiceOutputCatalog.Type;

const VoiceOutputModelRequest = Schema.Struct({ modelId: VoiceOutputId });

/** One sentence is the unit of work, so a reply starts playing before all of it is synthesized. */
export const VOICE_OUTPUT_MAX_TEXT_LENGTH = 2_000;

const VoiceOutputSpeakRequest = Schema.Struct({
  text: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(VOICE_OUTPUT_MAX_TEXT_LENGTH),
  ),
  /** Both or neither; without them the selected voice speaks. */
  modelId: Schema.optionalKey(VoiceOutputId),
  voiceId: Schema.optionalKey(VoiceOutputId),
});
export type VoiceOutputSpeakRequest = typeof VoiceOutputSpeakRequest.Type;

/** `start` and `end` are UTF-16 offsets into the spoken text; times are milliseconds into the audio. */
const VoiceOutputWord = Schema.Struct({
  start: Schema.Int,
  end: Schema.Int,
  t0Ms: Schema.Finite,
  t1Ms: Schema.Finite,
});
export type VoiceOutputWord = typeof VoiceOutputWord.Type;

const VoiceOutputSpeechHeader = Schema.Struct({
  sampleRate: Schema.Int.check(Schema.isBetween({ minimum: 8_000, maximum: 192_000 })),
  /** `estimated`: the audio's length spread over the words by character count. */
  timing: Schema.Literals(["estimated"]),
  words: Schema.Array(VoiceOutputWord),
});

export type VoiceOutputSpeech = typeof VoiceOutputSpeechHeader.Type & {
  /** Little-endian 16-bit mono PCM. */
  readonly pcm: Uint8Array;
};

const VOICE_OUTPUT_MAX_HEADER_BYTES = 256 * 1024;
const encodeSpeechHeader = Schema.encodeSync(Schema.fromJsonString(VoiceOutputSpeechHeader));
const decodeSpeechHeader = Schema.decodeUnknownSync(Schema.fromJsonString(VoiceOutputSpeechHeader));

/** A four-byte little-endian JSON length, the UTF-8 header, then the PCM: dictation's request format, reversed. */
export function encodeVoiceOutputSpeech(speech: VoiceOutputSpeech): Uint8Array<ArrayBuffer> {
  const { pcm, ...header } = speech;
  const metadata = new TextEncoder().encode(encodeSpeechHeader(header));
  if (metadata.byteLength > VOICE_OUTPUT_MAX_HEADER_BYTES)
    throw new Error("The speech header is too large.");
  const body = new Uint8Array(4 + metadata.byteLength + pcm.byteLength);
  new DataView(body.buffer).setUint32(0, metadata.byteLength, true);
  body.set(metadata, 4);
  body.set(pcm, 4 + metadata.byteLength);
  return body;
}

export function decodeVoiceOutputSpeech(body: Uint8Array): VoiceOutputSpeech {
  if (body.byteLength < 4) throw new Error("Missing speech header.");
  const length = new DataView(body.buffer, body.byteOffset, body.byteLength).getUint32(0, true);
  if (length > VOICE_OUTPUT_MAX_HEADER_BYTES || 4 + length > body.byteLength)
    throw new Error("Invalid speech header length.");
  const header = decodeSpeechHeader(
    new TextDecoder("utf-8", { fatal: true }).decode(body.subarray(4, 4 + length)),
  );
  const pcm = body.subarray(4 + length);
  if (pcm.byteLength % 2 !== 0) throw new Error("Invalid speech audio.");
  return { ...header, pcm };
}

export class VoiceOutputError extends Schema.TaggedError<VoiceOutputError>()(
  "VoiceOutputError",
  {
    reason: Schema.Literals([
      "unavailable",
      "unknown-voice",
      "no-voice-selected",
      "not-installed",
      "busy",
      "download",
      "verification",
      "synthesis",
    ]),
  },
  { httpApiStatus: 422 },
) {
  override get message() {
    switch (this.reason) {
      case "unavailable":
        return "Speech output is not available on this environment.";
      case "unknown-voice":
        return "That voice is not in the team's voice list.";
      case "no-voice-selected":
        return "Choose a voice in Settings → Voice.";
      case "not-installed":
        return "Download this voice model in Settings → Voice first.";
      case "busy":
        return "Another voice model is being installed or removed. Try again when it finishes.";
      case "download":
        return "The download failed. Check the connection and try again.";
      case "verification":
        return "The download did not match its expected checksum, so nothing was installed.";
      case "synthesis":
        return "The voice model could not speak this text.";
    }
  }
}

const OptionalBearerHeaders = Schema.Struct({
  authorization: Schema.optionalKey(Schema.String),
  dpop: Schema.optionalKey(Schema.String),
});

/**
 * Built by `environmentHttp.ts` from its own auth middleware and errors: importing them here at
 * runtime would make the two modules import each other.
 */
export const makeEnvironmentVoiceOutputHttpApi = (base: {
  readonly auth: typeof EnvironmentAuthenticatedAuth;
  readonly errors: readonly [
    typeof EnvironmentScopeRequiredError,
    typeof EnvironmentInternalError,
    typeof EnvironmentRequestInvalidError,
  ];
}) => {
  const error = [...base.errors, VoiceOutputError] as const;
  const change = {
    headers: OptionalBearerHeaders,
    payload: VoiceOutputModelRequest,
    success: VoiceOutputCatalog,
    error,
  };
  return HttpApiGroup.make("voiceOutput")
    .add(
      HttpApiEndpoint.get("catalog", "/api/voice-output/catalog", {
        headers: OptionalBearerHeaders,
        success: VoiceOutputCatalog,
        error,
      }).middleware(base.auth),
    )
    .add(
      HttpApiEndpoint.post("download", "/api/voice-output/models/download", change).middleware(
        base.auth,
      ),
    )
    .add(
      HttpApiEndpoint.post("cancel", "/api/voice-output/models/cancel", change).middleware(
        base.auth,
      ),
    )
    .add(
      HttpApiEndpoint.post("remove", "/api/voice-output/models/remove", change).middleware(
        base.auth,
      ),
    )
    .add(
      HttpApiEndpoint.post("select", "/api/voice-output/select", {
        headers: OptionalBearerHeaders,
        payload: VoiceOutputSelection,
        success: VoiceOutputCatalog,
        error,
      }).middleware(base.auth),
    )
    .add(
      HttpApiEndpoint.post("speak", "/api/voice-output/speak", {
        headers: OptionalBearerHeaders,
        payload: VoiceOutputSpeakRequest,
        success: Schema.Uint8Array.pipe(HttpApiSchema.asUint8Array()),
        error,
      }).middleware(base.auth),
    );
};
