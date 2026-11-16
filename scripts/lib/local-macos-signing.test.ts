import * as NodeServices from "@effect/platform-node/NodeServices";
import { FORK_DESKTOP } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { assert, describe, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import {
  applyLocalMacSigning,
  identityFingerprint,
  LOCAL_SIGNING_KEYCHAIN_ENV,
} from "./local-macos-signing.ts";

const FINGERPRINT = "D41DFA117E8654C2ABA309B35FA9292DC77571B8";
const KEYCHAIN = "/tmp/test.keychain-db";
const UNTRUSTED = `Policy: Code Signing
  Matching identities
  1) 0123456789ABCDEF0123456789ABCDEF01234567 "Apple Development: someone@example.com (TEAM123456)"
  2) ${FINGERPRINT} "${FORK_DESKTOP.localSigningIdentity}" (CSSMERR_TP_NOT_TRUSTED)
     2 identities found

  Valid identities only
  1) 0123456789ABCDEF0123456789ABCDEF01234567 "Apple Development: someone@example.com (TEAM123456)"
     1 valid identities found
`;
const NONE = "Policy: Code Signing\n  Matching identities\n     0 identities found\n";

type Reply = { readonly stdout?: string; readonly exitCode?: number };

/** Stands in for `security` and `openssl`; `respond` sees each command line. */
function stubCommands(respond: (args: ReadonlyArray<string>) => Reply) {
  const commands: Array<ReadonlyArray<string>> = [];
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.sync(() => {
      const args = ChildProcess.isStandardCommand(command)
        ? [command.command, ...command.args.map(String)]
        : [];
      commands.push(args);
      const reply = respond(args);
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(reply.exitCode ?? 0)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.make(new TextEncoder().encode(reply.stdout ?? "")),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  );
  return { commands, spawner };
}

const macConfig = (): Record<string, unknown> => ({
  productName: FORK_DESKTOP.productName,
  mac: { target: ["dir"], extendInfo: { NSCameraUsageDescription: "camera" } },
});

const apply = (
  buildConfig: Record<string, unknown>,
  build: { readonly platform: string; readonly signed: boolean },
  respond: (args: ReadonlyArray<string>) => Reply,
  hostPlatform: NodeJS.Platform = "darwin",
) => {
  const stub = stubCommands(respond);
  return applyLocalMacSigning(buildConfig, build).pipe(
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, stub.spawner),
    Effect.provideService(HostProcess.Platform, hostPlatform),
    Effect.provide(
      Layer.mergeAll(
        ConfigProvider.layer(
          ConfigProvider.fromEnv({ env: { [LOCAL_SIGNING_KEYCHAIN_ENV]: KEYCHAIN } }),
        ),
        NodeServices.layer,
      ),
    ),
    Effect.map(() => stub.commands.map((args) => args.slice(0, 2).join(" "))),
  );
};

const assertSignsLocally = (config: Record<string, unknown>) => {
  const mac = config.mac as Record<string, unknown>;
  assert.strictEqual(mac.identity, "-");
  assert.match(String(mac.sign), /scripts\/sign-macos-local\.ts$/);
  assert.deepInclude(mac, {
    extendInfo: { NSCameraUsageDescription: "camera" },
    hardenedRuntime: false,
    notarize: false,
    timestamp: "none",
  });
};

describe("local macOS signing", () => {
  it("reads the fingerprint of an untrusted identity", () => {
    assert.strictEqual(
      identityFingerprint(UNTRUSTED, FORK_DESKTOP.localSigningIdentity),
      FINGERPRINT,
    );
    assert.isUndefined(identityFingerprint(NONE, FORK_DESKTOP.localSigningIdentity));
  });

  it.effect("signs with an identity the keychain already holds, creating nothing", () =>
    Effect.gen(function* () {
      const config = macConfig();
      const commands = yield* apply(config, { platform: "mac", signed: false }, () => ({
        stdout: UNTRUSTED,
      }));
      assert.deepStrictEqual(commands, ["/usr/bin/security find-identity"]);
      assertSignsLocally(config);
    }),
  );

  it.effect("creates the identity in the chosen keychain when it is missing", () =>
    Effect.gen(function* () {
      let imported = false;
      const config = macConfig();
      const commands = yield* apply(config, { platform: "mac", signed: false }, (args) => {
        if (args[1] === "import") {
          imported = true;
          assert.deepInclude(args, KEYCHAIN);
          assert.deepInclude(args, "/usr/bin/codesign");
        }
        return args[1] === "find-identity" ? { stdout: imported ? UNTRUSTED : NONE } : {};
      });
      assert.deepStrictEqual(commands, [
        "/usr/bin/security find-identity",
        "/usr/bin/openssl req",
        "/usr/bin/openssl pkcs12",
        "/usr/bin/security import",
        "/usr/bin/security find-identity",
      ]);
      assertSignsLocally(config);
    }),
  );

  it.effect("stays ad-hoc signed when creating the identity fails", () =>
    Effect.gen(function* () {
      const config = macConfig();
      yield* apply(config, { platform: "mac", signed: false }, (args) =>
        args[1] === "import" ? { exitCode: 1 } : { stdout: NONE },
      );
      assert.deepStrictEqual(config, macConfig());
    }),
  );

  it.effect("leaves Developer ID, other platform and non-macOS host builds alone", () =>
    Effect.gen(function* () {
      for (const [build, host] of [
        [{ platform: "mac", signed: true }, "darwin"],
        [{ platform: "linux", signed: false }, "darwin"],
        [{ platform: "mac", signed: false }, "linux"],
      ] as const) {
        const config = macConfig();
        const commands = yield* apply(config, build, () => ({ stdout: UNTRUSTED }), host);
        assert.deepStrictEqual(commands, []);
        assert.deepStrictEqual(config, macConfig());
      }
    }),
  );
});
