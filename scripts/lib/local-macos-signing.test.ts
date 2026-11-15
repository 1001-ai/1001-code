import { FORK_DESKTOP } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { applyLocalMacSigning, listedSigningIdentityNames } from "./local-macos-signing.ts";

const VALID_LOCAL = `  1) 0123456789ABCDEF0123456789ABCDEF01234567 "Apple Development: someone@example.com (TEAM123456)"
  2) D41DFA117E8654C2ABA309B35FA9292DC77571B8 "${FORK_DESKTOP.localSigningIdentity}"
     2 valid identities found
`;
const UNTRUSTED_LOCAL = `Policy: Code Signing
  Matching identities
  1) D41DFA117E8654C2ABA309B35FA9292DC77571B8 "${FORK_DESKTOP.localSigningIdentity}" (CSSMERR_TP_NOT_TRUSTED)
     1 identities found

  Valid identities only
     0 valid identities found
`;

function stubSecurity(stdout: string) {
  const commands: Array<ReadonlyArray<string>> = [];
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.sync(() => {
      if (ChildProcess.isStandardCommand(command)) {
        commands.push([command.command, ...command.args.map(String)]);
      }
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.make(new TextEncoder().encode(stdout)),
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
  listing: string,
  hostPlatform: NodeJS.Platform = "darwin",
) => {
  const stub = stubSecurity(listing);
  return applyLocalMacSigning(buildConfig, build).pipe(
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, stub.spawner),
    Effect.provideService(HostProcess.Platform, hostPlatform),
    Effect.as(stub.commands),
  );
};

describe("local macOS signing", () => {
  it("reads identity names from security find-identity listings", () => {
    assert.deepStrictEqual(listedSigningIdentityNames(VALID_LOCAL), [
      "Apple Development: someone@example.com (TEAM123456)",
      FORK_DESKTOP.localSigningIdentity,
    ]);
    assert.deepStrictEqual(listedSigningIdentityNames(UNTRUSTED_LOCAL), [
      FORK_DESKTOP.localSigningIdentity,
    ]);
    assert.deepStrictEqual(listedSigningIdentityNames("     0 valid identities found\n"), []);
  });

  it.effect("signs an unsigned macOS build with the local identity when it is valid", () =>
    Effect.gen(function* () {
      const config = macConfig();
      const commands = yield* apply(config, { platform: "mac", signed: false }, VALID_LOCAL);
      assert.deepStrictEqual(commands, [
        ["/usr/bin/security", "find-identity", "-v", "-p", "codesigning"],
      ]);
      assert.deepStrictEqual(config.mac, {
        target: ["dir"],
        extendInfo: { NSCameraUsageDescription: "camera" },
        identity: FORK_DESKTOP.localSigningIdentity,
        hardenedRuntime: false,
        notarize: false,
        timestamp: "none",
      });
    }),
  );

  it.effect("stays ad-hoc signed when the local identity is missing", () =>
    Effect.gen(function* () {
      for (const listing of ["     0 valid identities found\n", VALID_LOCAL.split("\n")[0]!]) {
        const config = macConfig();
        yield* apply(config, { platform: "mac", signed: false }, listing);
        assert.deepStrictEqual(config, macConfig());
      }
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
        const commands = yield* apply(config, build, VALID_LOCAL, host);
        assert.deepStrictEqual(commands, []);
        assert.deepStrictEqual(config, macConfig());
      }
    }),
  );
});
