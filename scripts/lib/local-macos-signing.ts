import { FORK_DESKTOP } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Config from "effect/Config";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

const IDENTITY = FORK_DESKTOP.localSigningIdentity;
const SECURITY = "/usr/bin/security";
// LibreSSL's PKCS#12 files import with `security`; Homebrew's OpenSSL 3 defaults do not.
const OPENSSL = "/usr/bin/openssl";
// A locked keychain makes `security import` wait for a password nobody types in an unattended build.
const CREATE_TIMEOUT = Duration.minutes(2);

/** Test only: find or create the identity in this keychain instead of the login keychain. */
export const LOCAL_SIGNING_KEYCHAIN_ENV = "T3CODE_DESKTOP_LOCAL_SIGNING_KEYCHAIN";

export class LocalSigningCommandError extends Schema.TaggedError<LocalSigningCommandError>()(
  "LocalSigningCommandError",
  { command: Schema.String, exitCode: Schema.Number, stderr: Schema.String },
) {
  override get message() {
    return `${this.command} exited with code ${String(this.exitCode)}: ${this.stderr.trim()}`;
  }
}

/** SHA-1 fingerprint of the identity named `name` in a `security find-identity` listing. */
export function identityFingerprint(listing: string, name: string): string | undefined {
  for (const match of listing.matchAll(/^\s*\d+\)\s+([0-9A-F]{40})\s+"(.*)"/gim)) {
    if (match[2] === name) return match[1];
  }
  return undefined;
}

export const localSigningKeychain = Effect.gen(function* () {
  const override = yield* Config.String(LOCAL_SIGNING_KEYCHAIN_ENV).pipe(Config.withDefault(""));
  if (override.trim() !== "") return override;
  const path = yield* Path.Path;
  return path.join(yield* HostProcess.HomeDirectory, "Library/Keychains/login.keychain-db");
});

const collectText = <E>(stream: Stream.Stream<Uint8Array, E>) =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (text, chunk) => text + chunk,
    ),
  );

const run = Effect.fn("localSigning.run")(function* (command: string, args: ReadonlyArray<string>) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(ChildProcess.make(command, args));
  const [stdout, stderr, exitCode] = yield* Effect.all(
    [collectText(child.stdout), collectText(child.stderr), child.exitCode],
    { concurrency: "unbounded" },
  );
  if (Number(exitCode) !== 0) {
    return yield* new LocalSigningCommandError({
      command: `${command} ${args[0] ?? ""}`.trim(),
      exitCode: Number(exitCode),
      stderr,
    });
  }
  return stdout;
}, Effect.scoped);

/** Untrusted identities count: the Keychain and privacy checks compare only the certificate hash. */
export const findLocalSigningIdentity = Effect.fn("findLocalSigningIdentity")(function* (
  keychain: string,
) {
  const listing = yield* run(SECURITY, ["find-identity", "-p", "codesigning", keychain]).pipe(
    Effect.orElseSucceed(() => ""),
  );
  return Option.fromUndefinedOr(identityFingerprint(listing, IDENTITY));
});

const createLocalSigningIdentity = Effect.fn("createLocalSigningIdentity")(function* (
  keychain: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: "1001-code-signing-" });
  const config = path.join(dir, "openssl.cnf");
  const key = path.join(dir, "key.pem");
  const cert = path.join(dir, "cert.pem");
  const p12 = path.join(dir, "identity.p12");
  // The PKCS#12 file lives only in this private temporary directory; the password guards nothing else.
  const password = "1001-code-local-signing";
  yield* fs.writeFileString(
    config,
    [
      "[req]",
      "distinguished_name = dn",
      "prompt = no",
      "[dn]",
      `CN = ${IDENTITY}`,
      "[codesign]",
      "basicConstraints = critical,CA:false",
      "keyUsage = critical,digitalSignature",
      "extendedKeyUsage = critical,codeSigning",
      "subjectKeyIdentifier = hash",
      "",
    ].join("\n"),
  );
  yield* run(OPENSSL, [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "3650",
    "-config",
    config,
    "-extensions",
    "codesign",
    "-keyout",
    key,
    "-out",
    cert,
  ]);
  yield* run(OPENSSL, [
    "pkcs12",
    "-export",
    "-name",
    IDENTITY,
    "-inkey",
    key,
    "-in",
    cert,
    "-out",
    p12,
    "-passout",
    `pass:${password}`,
  ]);
  // -T lets codesign use the private key without asking.
  yield* run(SECURITY, ["import", p12, "-k", keychain, "-P", password, "-T", "/usr/bin/codesign"]);
  const created = yield* findLocalSigningIdentity(keychain);
  if (Option.isNone(created)) {
    return yield* new LocalSigningCommandError({
      command: `${SECURITY} find-identity`,
      exitCode: 0,
      stderr: `"${IDENTITY}" is missing after the import.`,
    });
  }
  return created.value;
}, Effect.scoped);

/** The identity's fingerprint, creating the identity first when the keychain lacks it. */
export const ensureLocalSigningIdentity = Effect.fn("ensureLocalSigningIdentity")(function* (
  keychain: string,
) {
  const existing = yield* findLocalSigningIdentity(keychain);
  if (Option.isSome(existing)) return existing;
  return yield* createLocalSigningIdentity(keychain).pipe(
    Effect.timeout(CREATE_TIMEOUT),
    Effect.tap((fingerprint) =>
      Effect.log(
        `[desktop-artifact] Created the "${IDENTITY}" code signing identity (${fingerprint}) in ${keychain}; later builds reuse it.`,
      ),
    ),
    Effect.asSome,
    Effect.catch((error) =>
      Effect.logWarning(
        `[desktop-artifact] Could not create the "${IDENTITY}" code signing identity in ${keychain}, so the app is ad-hoc signed: ${error.message}`,
      ).pipe(Effect.as(Option.none<string>())),
    ),
  );
});

/**
 * An ad-hoc signature's designated requirement is a cdhash, which every rebuild changes, so macOS
 * forgets Keychain and privacy grants. Unsigned macOS builds sign with the local identity instead.
 * electron-builder's own lookup skips untrusted identities, so it is asked for ad-hoc ("-") and
 * `sign-macos-local.ts` swaps in the fingerprint.
 */
export const applyLocalMacSigning = Effect.fn("applyLocalMacSigning")(function* (
  buildConfig: Record<string, unknown>,
  build: { readonly platform: string; readonly signed: boolean },
) {
  if (build.platform !== "mac" || build.signed || (yield* HostProcess.Platform) !== "darwin") {
    return;
  }
  const fingerprint = yield* ensureLocalSigningIdentity(yield* localSigningKeychain);
  if (Option.isNone(fingerprint)) return;
  const path = yield* Path.Path;
  yield* Effect.log(
    `[desktop-artifact] Signing the app with the "${IDENTITY}" identity (${fingerprint.value}).`,
  );
  // Without a Team ID, library validation rejects the app's own frameworks under the hardened
  // runtime. A self-signed app is never notarized, so it needs no secure timestamp either.
  buildConfig.mac = {
    ...(buildConfig.mac as Record<string, unknown>),
    identity: "-",
    sign: path.join(import.meta.dirname, "..", "sign-macos-local.ts"),
    hardenedRuntime: false,
    notarize: false,
    timestamp: "none",
  };
});
