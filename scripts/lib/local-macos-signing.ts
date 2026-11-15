import { FORK_DESKTOP } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

export const LOCAL_SIGNING_IDENTITY_SETUP_COMMAND = "vp run dist:desktop:signing-identity";

/** Identity names in a `security find-identity` listing. */
export function listedSigningIdentityNames(listing: string): ReadonlyArray<string> {
  return Array.from(
    listing.matchAll(/^\s*\d+\)\s+[0-9A-F]{40}\s+"(.*)"/gim),
    (match) => match[1] ?? "",
  );
}

/**
 * Without a Team ID, library validation would reject the app's own frameworks under the hardened
 * runtime, so it stays off, as in an unsigned build. A self-signed app is never notarized, so it
 * needs no secure timestamp from Apple's server either.
 */
export function signWithLocalIdentity(buildConfig: Record<string, unknown>, identity: string) {
  buildConfig.mac = {
    ...(buildConfig.mac as Record<string, unknown>),
    identity,
    hardenedRuntime: false,
    notarize: false,
    timestamp: "none",
  };
}

/**
 * An ad-hoc signature's designated requirement is a cdhash, which every rebuild changes, so macOS
 * forgets Keychain grants. Unsigned macOS builds sign with the local certificate instead when
 * `security` lists it as valid (electron-builder's own query), and otherwise stay ad-hoc.
 */
export const applyLocalMacSigning = Effect.fn("applyLocalMacSigning")(function* (
  buildConfig: Record<string, unknown>,
  build: { readonly platform: string; readonly signed: boolean },
) {
  if (build.platform !== "mac" || build.signed || (yield* HostProcess.Platform) !== "darwin") {
    return;
  }
  const identity = FORK_DESKTOP.localSigningIdentity;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const listing = yield* spawner
    .string(ChildProcess.make("/usr/bin/security", ["find-identity", "-v", "-p", "codesigning"]))
    .pipe(Effect.orElseSucceed(() => ""));
  if (!listedSigningIdentityNames(listing).includes(identity)) {
    yield* Effect.log(
      `[desktop-artifact] No "${identity}" signing identity, so the app is ad-hoc signed and macOS asks for the Keychain password again after each rebuild. To fix that, run once: ${LOCAL_SIGNING_IDENTITY_SETUP_COMMAND}`,
    );
    return;
  }
  yield* Effect.log(`[desktop-artifact] Signing the app with the "${identity}" identity.`);
  signWithLocalIdentity(buildConfig, identity);
});
