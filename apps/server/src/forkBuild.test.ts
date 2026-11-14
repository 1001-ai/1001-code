import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { FORK_RELEASE_DOWNLOAD_MESSAGE, FORK_UPDATES_MESSAGE } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import { runUpdate } from "./cli/update.ts";
import * as BootService from "./cloud/bootService.ts";
import { ensurePinnedRuntimeInstalled } from "./cloud/pinnedRuntime.ts";
import * as ServerConfig from "./config.ts";
import * as ManagedPolicy from "./policy/ManagedPolicy.ts";
import * as ProcessRunner from "./processRunner.ts";
import * as AnalyticsService from "./telemetry/AnalyticsService.ts";

const unexpectedRequest = HttpClient.make(() => Effect.die("unexpected request"));

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))("fork build defaults", (it) => {
  it.effect.each([
    { name: "nothing is configured", env: {}, sent: 0 },
    {
      name: "only T3CODE_TELEMETRY_ENABLED is on",
      env: { T3CODE_TELEMETRY_ENABLED: true },
      sent: 0,
    },
    {
      name: "an endpoint and key are named too",
      env: {
        T3CODE_TELEMETRY_ENABLED: true,
        T3CODE_POSTHOG_HOST: "http://localhost",
        T3CODE_POSTHOG_KEY: "phc_test_key",
      },
      sent: 1,
    },
  ])("analytics requests when $name: $sent", ({ env, sent }) =>
    Effect.gen(function* () {
      const urls: Array<string> = [];
      const client = HttpClient.make((request) => {
        urls.push(request.url);
        return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null)));
      });
      yield* Effect.gen(function* () {
        const analytics = yield* AnalyticsService.AnalyticsService;
        yield* analytics.record("test.fork-defaults");
        yield* analytics.flush;
      }).pipe(
        Effect.provide(
          AnalyticsService.layer.pipe(
            Layer.provideMerge(
              ServerConfig.ServerConfig.layerTest(process.cwd(), { prefix: "t3-fork-telemetry-" }),
            ),
            Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))),
            Layer.provide(
              Layer.mergeAll(
                Layer.succeed(HostProcess.Platform, "linux"),
                Layer.succeed(HostProcess.Architecture, "x64"),
                Layer.succeed(HttpClient.HttpClient, client),
                ManagedPolicy.layerTest(),
              ),
            ),
          ),
        ),
      );
      assert.equal(urls.length, sent);
    }),
  );

  it.effect("t3 update does not look for releases without a policy mirror", () =>
    Effect.gen(function* () {
      const error = yield* runUpdate({
        baseDir: "/unused",
        logsDir: "/unused",
        serverRuntimeStatePath: "/unused",
        channel: undefined,
        requestedVersion: undefined,
        allowDowngrade: false,
        assumeYes: true,
      }).pipe(
        Effect.flip,
        Effect.provide(
          Layer.mergeAll(
            ManagedPolicy.layerTest(),
            Layer.mock(BootService.BootService, {}),
            Layer.mock(ProcessRunner.ProcessRunner, {}),
            Layer.succeed(HttpClient.HttpClient, unexpectedRequest),
          ),
        ),
      );
      assert.equal(error.message, FORK_UPDATES_MESSAGE);
    }),
  );

  it.effect("downloads no release archive without a named release source", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const error = yield* ensurePinnedRuntimeInstalled({
        baseDir: yield* fs.makeTempDirectoryScoped({ prefix: "t3-fork-pinned-runtime-" }),
        version: "1.2.3",
        fs,
        path,
        platform: "linux",
        arch: "x64",
        httpClient: unexpectedRequest,
        runner: ProcessRunner.ProcessRunner.of({ run: () => Effect.die("unexpected command") }),
        validate: () => Effect.die("unexpected validation"),
      }).pipe(Effect.flip);
      assert.include(error.message, FORK_RELEASE_DOWNLOAD_MESSAGE);
    }),
  );
});
