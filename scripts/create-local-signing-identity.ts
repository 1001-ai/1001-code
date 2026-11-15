#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off
// Creates the self-signed code signing identity that unsigned macOS builds of 1001 Code sign
// with, so every rebuild keeps one code identity and macOS keeps the app's Keychain access.
// Run once per Mac. See fork/README.md, "Desktop app is 1001 Code, with its own identity".
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import { FORK_DESKTOP } from "@t3tools/contracts";
import { listedSigningIdentityNames } from "./lib/local-macos-signing.ts";

const USAGE = `node scripts/create-local-signing-identity.ts [--keychain <path>]

Creates the "${FORK_DESKTOP.localSigningIdentity}" certificate (RSA 2048, code signing, 10 years),
imports it into the login keychain for codesign, and trusts it for code signing. Does nothing
when it is already there. macOS asks for your password to trust it.

  --keychain <path>  Import into this keychain instead, and skip trusting the certificate.
                     Trust settings belong to the user, not to a keychain; this is for testing
                     the script against a throwaway keychain.`;

const IDENTITY = FORK_DESKTOP.localSigningIdentity;
// LibreSSL's PKCS#12 files import with `security`; Homebrew's OpenSSL 3 defaults do not.
const OPENSSL = "/usr/bin/openssl";
const SECURITY = "/usr/bin/security";

const { values } = NodeUtil.parseArgs({
  options: { keychain: { type: "string" }, help: { type: "boolean", short: "h" } },
});
if (values.help) {
  console.log(USAGE);
  process.exit(0);
}
if (!NodeFS.existsSync(SECURITY) || !NodeFS.existsSync(OPENSSL)) {
  console.error(
    `Local code signing is for macOS builds only; it needs ${SECURITY} and ${OPENSSL}.`,
  );
  process.exit(1);
}

const testKeychain = values.keychain !== undefined;
const keychain = NodePath.resolve(
  values.keychain ?? NodePath.join(NodeOS.homedir(), "Library/Keychains/login.keychain-db"),
);

const run = (
  command: string,
  args: ReadonlyArray<string>,
  options?: { readonly quiet?: boolean },
) =>
  NodeChildProcess.execFileSync(command, args, {
    encoding: "utf8",
    stdio: ["inherit", "pipe", options?.quiet ? "pipe" : "inherit"],
  });

const listed = (validOnly: boolean) =>
  listedSigningIdentityNames(
    run(SECURITY, ["find-identity", ...(validOnly ? ["-v"] : []), "-p", "codesigning", keychain]),
  ).includes(IDENTITY);

if (listed(!testKeychain)) {
  console.log(
    `"${IDENTITY}" is already in ${keychain}${testKeychain ? "" : " and trusted for code signing"}. Nothing to do.`,
  );
  process.exit(0);
}

const workDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "1001-code-signing-"));
try {
  const certPath = NodePath.join(workDir, "cert.pem");
  if (listed(false)) {
    NodeFS.writeFileSync(
      certPath,
      run(SECURITY, ["find-certificate", "-c", IDENTITY, "-p", keychain]),
    );
    console.log(`"${IDENTITY}" is already in ${keychain}, but not trusted for code signing.`);
  } else {
    const configPath = NodePath.join(workDir, "openssl.cnf");
    const keyPath = NodePath.join(workDir, "key.pem");
    const p12Path = NodePath.join(workDir, "identity.p12");
    const p12Password = NodeCrypto.randomBytes(24).toString("hex");
    NodeFS.writeFileSync(
      configPath,
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
    run(
      OPENSSL,
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-days",
        "3650",
        "-config",
        configPath,
        "-extensions",
        "codesign",
        "-keyout",
        keyPath,
        "-out",
        certPath,
      ],
      { quiet: true },
    );
    run(
      OPENSSL,
      [
        "pkcs12",
        "-export",
        "-name",
        IDENTITY,
        "-inkey",
        keyPath,
        "-in",
        certPath,
        "-out",
        p12Path,
        "-passout",
        `pass:${p12Password}`,
      ],
      { quiet: true },
    );
    run(SECURITY, [
      "import",
      p12Path,
      "-k",
      keychain,
      "-P",
      p12Password,
      "-T",
      "/usr/bin/codesign",
    ]);
    console.log(
      `Created "${IDENTITY}" (RSA 2048, code signing, valid 10 years) and imported it into ${keychain}; codesign may use its private key without asking.`,
    );
  }

  if (testKeychain) {
    console.log("Skipped trusting it: --keychain is for testing, and trust settings are per user.");
  } else {
    console.log("Trusting it for code signing. macOS asks for your password.");
    run(SECURITY, ["add-trusted-cert", "-p", "codeSign", "-k", keychain, certPath]);
    if (!listed(true)) {
      throw new Error(`"${IDENTITY}" is still not a valid code signing identity.`);
    }
    console.log(
      `Trusted it for code signing. The next 1001 Code build is signed with "${IDENTITY}". If macOS asks for the Keychain once more, choose Always Allow.`,
    );
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  NodeFS.rmSync(workDir, { recursive: true, force: true });
}
