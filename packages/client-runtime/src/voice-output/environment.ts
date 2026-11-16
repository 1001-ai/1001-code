import {
  decodeVoiceOutputSpeech,
  VOICE_OUTPUT_MAX_TEXT_LENGTH,
  VoiceOutputError,
  type VoiceOutputSelection,
  type VoiceOutputSpeech,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import type { PreparedConnection } from "../connection/model.ts";
import * as ManagedRelay from "../relay/managedRelay.ts";
import {
  makeEnvironmentHttpApiGroupClient,
  makeEnvironmentHttpApiUrlBuilder,
  RemoteEnvironmentAuthFetchError,
} from "../rpc/http.ts";
import { executeAuthenticatedEnvironmentHttpRequest } from "../state/environmentHttpAuth.ts";
import { splitVoiceOutputSentences } from "./speech.logic.ts";

const DOWNLOAD_OR_SYNTHESIS_TIMEOUT_MS = 30 * 60_000;
const isVoiceOutputError = Schema.is(VoiceOutputError);
type Client = Effect.Success<ReturnType<typeof makeEnvironmentHttpApiGroupClient<"voiceOutput">>>;
type Urls = ReturnType<typeof makeEnvironmentHttpApiUrlBuilder>["voiceOutput"];
type Headers = { readonly authorization?: string; readonly dpop?: string };

/** Uses the path dictation uses, so local, remote and relay environments all work. */
const request = Effect.fn("clientRuntime.voiceOutput.environmentRequest")(function* <A, E>(input: {
  readonly prepared: PreparedConnection;
  readonly method: "GET" | "POST";
  readonly timeoutMs?: number;
  readonly path: (urls: Urls) => string;
  readonly run: (input: {
    readonly client: Client;
    readonly headers: Headers;
  }) => Effect.Effect<A, E>;
}) {
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    group: "voiceOutput",
    prepared: input.prepared,
    signer: yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner),
    remoteAuthorization: yield* Effect.serviceOption(
      RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization,
    ),
    method: input.method,
    url: input.path,
    timeoutMs: input.timeoutMs ?? 30_000,
    // Text to speak and credentials never follow a redirect to another host.
    requestInit: { redirect: "error" },
    request: input.run,
  }).pipe(
    // The server's own reason, such as a failed checksum, reads better than a transport error.
    Effect.mapError((error) =>
      error._tag === "RemoteEnvironmentAuthFetchError" && isVoiceOutputError(error.cause)
        ? error.cause
        : error,
    ),
  );
});

export const getVoiceOutputCatalog = (prepared: PreparedConnection) =>
  request({
    prepared,
    method: "GET",
    path: (urls) => urls.catalog(),
    run: ({ client, headers }) => client.catalog({ headers }),
  });

/** Resolves when the install ends; poll the catalog for progress meanwhile. */
export const downloadVoiceOutputModel = (prepared: PreparedConnection, modelId: string) =>
  request({
    prepared,
    method: "POST",
    timeoutMs: DOWNLOAD_OR_SYNTHESIS_TIMEOUT_MS,
    path: (urls) => urls.download(),
    run: ({ client, headers }) => client.download({ headers, payload: { modelId } }),
  });

export const cancelVoiceOutputModelDownload = (prepared: PreparedConnection, modelId: string) =>
  request({
    prepared,
    method: "POST",
    path: (urls) => urls.cancel(),
    run: ({ client, headers }) => client.cancel({ headers, payload: { modelId } }),
  });

export const removeVoiceOutputModel = (prepared: PreparedConnection, modelId: string) =>
  request({
    prepared,
    method: "POST",
    path: (urls) => urls.remove(),
    run: ({ client, headers }) => client.remove({ headers, payload: { modelId } }),
  });

export const selectVoiceOutputVoice = (prepared: PreparedConnection, voice: VoiceOutputSelection) =>
  request({
    prepared,
    method: "POST",
    path: (urls) => urls.select(),
    run: ({ client, headers }) => client.select({ headers, payload: voice }),
  });

/** Speaks one sentence. Without `voice`, the voice chosen in settings speaks. */
const speakVoiceOutputSentence = (
  prepared: PreparedConnection,
  text: string,
  voice?: VoiceOutputSelection,
) =>
  request({
    prepared,
    method: "POST",
    timeoutMs: DOWNLOAD_OR_SYNTHESIS_TIMEOUT_MS,
    path: (urls) => urls.speak(),
    run: ({ client, headers }) => client.speak({ headers, payload: { text, ...voice } }),
  }).pipe(
    Effect.flatMap((body) =>
      Effect.try({
        try: () => decodeVoiceOutputSpeech(body),
        catch: (cause) =>
          new RemoteEnvironmentAuthFetchError({
            message: "The environment returned speech this client cannot read.",
            cause,
          }),
      }),
    ),
  );

export type VoiceOutputSpokenSentence = VoiceOutputSpeech & {
  /** The sentence as spoken, and where it starts in the whole text. */
  readonly text: string;
  readonly start: number;
};

/**
 * Speaks a text sentence by sentence, in order. Each element is one sentence's audio with word
 * offsets into the whole text; the next sentence is requested when the consumer asks for it, so
 * stopping the stream stops the speech.
 */
export const speakVoiceOutputText = (
  prepared: PreparedConnection,
  text: string,
  voice?: VoiceOutputSelection,
) =>
  Stream.fromIterable(splitVoiceOutputSentences(text, VOICE_OUTPUT_MAX_TEXT_LENGTH)).pipe(
    Stream.mapEffect((sentence) =>
      speakVoiceOutputSentence(prepared, sentence.text, voice).pipe(
        Effect.map((speech): VoiceOutputSpokenSentence => ({
          ...speech,
          text: sentence.text,
          start: sentence.start,
          words: speech.words.map((word) => ({
            ...word,
            start: word.start + sentence.start,
            end: word.end + sentence.start,
          })),
        })),
      ),
    ),
  );
