import {
  AuthOrchestrationOperateScope,
  AuthSettingsWriteScope,
  type AuthEnvironmentScope,
  encodeVoiceOutputSpeech,
  EnvironmentHttpApi,
  type VoiceOutputError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  requireEnvironmentScope,
} from "../auth/http.ts";
import * as VoiceOutput from "./VoiceOutput.ts";

const mapStateError = <A, R>(
  effect: Effect.Effect<A, VoiceOutputError | VoiceOutput.VoiceOutputStateError, R>,
) =>
  effect.pipe(
    Effect.catchTags({
      VoiceOutputStateError: (error) => failEnvironmentInternal("internal_error", error),
    }),
  );

/** Reading the catalog and speaking need the operate scope; changing what is installed or chosen needs settings write, as dictation does. */
export const layer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "voiceOutput",
  Effect.fnUntraced(function* (handlers) {
    const voiceOutput = yield* VoiceOutput.VoiceOutput;
    const guard = Effect.fnUntraced(function* (
      endpoint: string,
      scope: AuthEnvironmentScope = AuthOrchestrationOperateScope,
    ) {
      yield* annotateEnvironmentRequest(endpoint);
      yield* requireEnvironmentScope(scope);
    });
    return handlers
      .handle(
        "catalog",
        Effect.fn("environment.voiceOutput.catalog")(function* (args) {
          yield* guard(args.endpoint.name);
          return yield* voiceOutput.catalog;
        }),
      )
      .handle(
        "download",
        Effect.fn("environment.voiceOutput.download")(function* (args) {
          yield* guard(args.endpoint.name, AuthSettingsWriteScope);
          return yield* voiceOutput.download(args.payload.modelId);
        }),
      )
      .handle(
        "cancel",
        Effect.fn("environment.voiceOutput.cancel")(function* (args) {
          yield* guard(args.endpoint.name, AuthSettingsWriteScope);
          return yield* voiceOutput.cancel(args.payload.modelId);
        }),
      )
      .handle(
        "remove",
        Effect.fn("environment.voiceOutput.remove")(function* (args) {
          yield* guard(args.endpoint.name, AuthSettingsWriteScope);
          return yield* voiceOutput.remove(args.payload.modelId).pipe(mapStateError);
        }),
      )
      .handle(
        "select",
        Effect.fn("environment.voiceOutput.select")(function* (args) {
          yield* guard(args.endpoint.name, AuthSettingsWriteScope);
          return yield* voiceOutput.select(args.payload).pipe(mapStateError);
        }),
      )
      .handle(
        "speak",
        Effect.fn("environment.voiceOutput.speak")(function* (args) {
          yield* guard(args.endpoint.name);
          return encodeVoiceOutputSpeech(yield* voiceOutput.speak(args.payload));
        }),
      );
  }),
);
