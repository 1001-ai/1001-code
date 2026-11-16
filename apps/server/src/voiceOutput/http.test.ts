import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  AuthSessionId,
  AuthSettingsWriteScope,
  type AuthEnvironmentScope,
  decodeVoiceOutputSpeech,
  EnvironmentAuthenticatedAuth,
  EnvironmentAuthenticatedPrincipal,
  EnvironmentVoiceOutputHttpApi,
  VoiceOutputError,
  type VoiceOutputCatalog,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import { vi } from "vite-plus/test";

import * as VoiceOutputHttp from "./http.ts";
import * as VoiceOutput from "./VoiceOutput.ts";

const decodeSessionId = Schema.decodeUnknownSync(AuthSessionId);
const catalog: VoiceOutputCatalog = {
  unavailable: null,
  runtime: { state: "installed", size: 10 },
  models: [],
  selection: null,
};

const serve = Effect.fn("voiceOutput.http.test.serve")(function* (
  scopes: ReadonlyArray<AuthEnvironmentScope>,
  service: Partial<VoiceOutput.VoiceOutput["Service"]> = {},
) {
  const calls = {
    download: vi.fn(() => Effect.succeed(catalog)),
    cancel: vi.fn(() => Effect.succeed(catalog)),
    remove: vi.fn(() => Effect.succeed(catalog)),
    select: vi.fn(() => Effect.succeed(catalog)),
    speak: vi.fn(() =>
      Effect.succeed({
        sampleRate: 24_000,
        timing: "estimated" as const,
        words: [{ start: 0, end: 6, t0Ms: 0, t1Ms: 500 }],
        pcm: new Uint8Array([1, 2, 3, 4]),
      }),
    ),
  };
  const { handler, dispose } = HttpRouter.toWebHandler(
    HttpApiBuilder.layer(HttpApi.make("environment").add(EnvironmentVoiceOutputHttpApi)).pipe(
      Layer.provide(VoiceOutputHttp.layer),
      Layer.provide(
        Layer.succeed(EnvironmentAuthenticatedAuth, (effect) =>
          effect.pipe(
            Effect.provideService(EnvironmentAuthenticatedPrincipal, {
              sessionId: decodeSessionId("voice-output-test"),
              subject: "test",
              method: "bearer-access-token",
              scopes: new Set(scopes),
            }),
          ),
        ),
      ),
      Layer.provide(
        Layer.succeed(VoiceOutput.VoiceOutput, {
          catalog: Effect.succeed(catalog),
          ...calls,
          ...service,
        }),
      ),
      Layer.provide(HttpServer.layerServices),
      Layer.provide(NodeServices.layer),
    ),
    { disableLogger: true },
  );
  yield* Effect.addFinalizer(() => Effect.promise(dispose));
  const context = yield* Layer.build(NodeServices.layer);
  const post = (path: string, body: unknown) =>
    Effect.promise(() =>
      handler(
        new Request(`http://localhost/api/voice-output/${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
        context,
      ),
    );
  const get = (path: string) =>
    Effect.promise(() =>
      handler(new Request(`http://localhost/api/voice-output/${path}`), context),
    );
  return { calls, post, get };
});

const changes = [
  ["models/download", { modelId: "lantern" }, "download"],
  ["models/cancel", { modelId: "lantern" }, "cancel"],
  ["models/remove", { modelId: "lantern" }, "remove"],
  ["select", { modelId: "lantern", voiceId: "amber" }, "select"],
] as const;

it.effect(
  "lets an operator read the catalog and speak, but not change what is installed or chosen",
  () =>
    Effect.gen(function* () {
      const { calls, post, get } = yield* serve([AuthOrchestrationOperateScope]);
      const listed = yield* get("catalog");
      expect(listed.status).toBe(200);
      expect(yield* Effect.promise(() => listed.json())).toEqual(catalog);
      for (const [path, body, method] of changes) {
        expect((yield* post(path, body)).status).toBe(403);
        expect(calls[method]).not.toHaveBeenCalled();
      }

      const spoken = yield* post("speak", { text: "Hello.", modelId: "lantern", voiceId: "amber" });
      expect(spoken.status).toBe(200);
      expect(spoken.headers.get("content-type")).toBe("application/octet-stream");
      const speech = decodeVoiceOutputSpeech(
        new Uint8Array(yield* Effect.promise(() => spoken.arrayBuffer())),
      );
      expect(speech).toEqual({
        sampleRate: 24_000,
        timing: "estimated",
        words: [{ start: 0, end: 6, t0Ms: 0, t1Ms: 500 }],
        pcm: new Uint8Array([1, 2, 3, 4]),
      });
      expect(calls.speak).toHaveBeenCalledWith({
        text: "Hello.",
        modelId: "lantern",
        voiceId: "amber",
      });
      // Text is one sentence at a time, and never empty.
      expect((yield* post("speak", { text: "" })).status).toBe(400);
      expect((yield* post("speak", { text: "x".repeat(2_001) })).status).toBe(400);
    }).pipe(Effect.scoped),
);

it.effect("needs the operate scope to read or speak, and settings write to change", () =>
  Effect.gen(function* () {
    const { calls, post, get } = yield* serve([AuthSettingsWriteScope]);
    expect((yield* get("catalog")).status).toBe(403);
    expect((yield* post("speak", { text: "Hello." })).status).toBe(403);
    expect(calls.speak).not.toHaveBeenCalled();
    for (const [path, body, method] of changes) {
      const response = yield* post(path, body);
      expect(response.status).toBe(200);
      expect(yield* Effect.promise(() => response.json())).toEqual(catalog);
      expect(calls[method]).toHaveBeenCalledOnce();
    }
    expect(calls.select).toHaveBeenCalledWith({ modelId: "lantern", voiceId: "amber" });
    expect((yield* post("select", { modelId: "../etc", voiceId: "amber" })).status).toBe(400);
    expect(calls.select).toHaveBeenCalledOnce();
  }).pipe(Effect.scoped),
);

it.effect("returns the service's reason, and hides a disk failure behind an internal error", () =>
  Effect.gen(function* () {
    const { post } = yield* serve([AuthOrchestrationOperateScope, AuthSettingsWriteScope], {
      download: () => Effect.fail(new VoiceOutputError({ reason: "verification" })),
      remove: () =>
        Effect.fail(
          new VoiceOutput.VoiceOutputStateError({
            operation: "remove",
            cause: new Error("EACCES /home/someone/state"),
          }),
        ),
    });
    const failed = yield* post("models/download", { modelId: "lantern" });
    expect(failed.status).toBe(422);
    expect(yield* Effect.promise(() => failed.json())).toEqual({
      _tag: "VoiceOutputError",
      reason: "verification",
    });
    const broken = yield* post("models/remove", { modelId: "lantern" });
    expect(broken.status).toBe(500);
    expect(yield* Effect.promise(() => broken.text())).not.toContain("/home/someone");
  }).pipe(Effect.scoped),
);
