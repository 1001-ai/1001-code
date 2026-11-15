// @effect-diagnostics globalConsole:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import { sign, type SignOptions } from "@electron/osx-sign";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { findLocalSigningIdentity, localSigningKeychain } from "./lib/local-macos-signing.ts";

/** electron-builder's `mac.sign` for unsigned macOS builds; see `applyLocalMacSigning`. */
export default async function signWithLocalIdentity(options: SignOptions): Promise<void> {
  const { keychain, fingerprint } = await Effect.runPromise(
    Effect.gen(function* () {
      const keychain = yield* localSigningKeychain;
      return { keychain, fingerprint: yield* findLocalSigningIdentity(keychain) };
    }).pipe(Effect.provide(NodeServices.layer)),
  );
  if (Option.isNone(fingerprint)) {
    console.warn(`The local signing identity left ${keychain}; signing the app ad hoc.`);
    await sign({ ...options, identity: "-", batchCodesignCalls: true });
    return;
  }
  await sign({
    ...options,
    identity: fingerprint.value,
    keychain,
    identityValidation: false,
    batchCodesignCalls: true,
  });
}
