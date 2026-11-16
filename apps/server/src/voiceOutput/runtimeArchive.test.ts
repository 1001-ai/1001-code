import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { isUnsafeArchiveEntry, makeRuntimeArchiveExtractor } from "./runtimeArchive.ts";
import { tarGz } from "./tarFixture.ts";

const LIBRARY = "libs/libfixture.so.0.1.0";
const library = { name: LIBRARY, data: new TextEncoder().encode("not a real library") };

const harness = Effect.fn("runtimeArchive.test.harness")(function* (archive: Uint8Array) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "voice-runtime-archive-" });
  const archivePath = path.join(root, "runtime.tar.gz");
  yield* fs.writeFile(archivePath, archive);
  const destination = path.join(root, "runtime", "audio-cpp-fixture");
  yield* fs.makeDirectory(path.dirname(destination), { recursive: true });
  const extract = yield* makeRuntimeArchiveExtractor;
  const result = yield* Effect.result(
    extract({ archivePath, destination, library: LIBRARY, version: "fixture-1" }),
  );
  return { fs, path, root, destination, result };
});

const dependencies = Layer.mergeAll(NodeServices.layer, NodeCrypto.layer);

it.each([
  ["libs/libfixture.so", false],
  ["./libs/", false],
  ["../evil", true],
  ["libs/../../evil", true],
  ["/etc/hosts", true],
  ["C:/Windows/evil.dll", true],
  ["libs\\..\\evil", true],
  ["", true],
])("judges the archive entry %j", (entry, unsafe) => {
  expect(isUnsafeArchiveEntry(entry)).toBe(unsafe);
});

it.effect("installs an archive whose entries and links stay inside, marker last", () =>
  Effect.gen(function* () {
    const h = yield* harness(
      tarGz([library, { name: "libs/libfixture.so", linkTo: "libfixture.so.0.1.0" }]),
    );
    expect(h.result._tag).toBe("Success");
    expect((yield* h.fs.readDirectory(h.destination)).sort()).toEqual([".t3-complete", "libs"]);
    expect(yield* h.fs.readFileString(h.path.join(h.destination, ".t3-complete"))).toBe(
      "fixture-1",
    );
    expect(yield* h.fs.readFileString(h.path.join(h.destination, LIBRARY))).toBe(
      "not a real library",
    );
    expect(yield* h.fs.readDirectory(h.path.dirname(h.destination))).toEqual(["audio-cpp-fixture"]);
  }).pipe(Effect.scoped, Effect.provide(dependencies)),
);

it.effect.each([
  [
    "an entry that climbs out of the folder",
    [library, { name: "../evil.txt", data: new Uint8Array([1]) }],
    "entry",
  ],
  [
    "a link that points outside the folder",
    [library, { name: "libs/outside", linkTo: "/etc/hosts" }],
    "contents",
  ],
  [
    "a library that is only a link",
    [
      { name: "libs/real.so", data: new Uint8Array([1]) },
      { name: LIBRARY, linkTo: "real.so" },
    ],
    "contents",
  ],
  ["no library", [{ name: "libs/readme.txt", data: new Uint8Array([1]) }], "contents"],
] as const)("refuses an archive with %s and leaves nothing behind", ([, entries, stage]) =>
  Effect.gen(function* () {
    const h = yield* harness(tarGz(entries));
    expect(h.result).toMatchObject({ _tag: "Failure", failure: { stage } });
    expect(yield* h.fs.readDirectory(h.path.dirname(h.destination))).toEqual([]);
    expect(yield* h.fs.exists(h.path.join(h.root, "evil.txt"))).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(dependencies)),
);

it.effect("refuses bytes that are not an archive", () =>
  Effect.gen(function* () {
    const h = yield* harness(new Uint8Array([1, 2, 3, 4]));
    expect(h.result).toMatchObject({ _tag: "Failure", failure: { stage: "listing" } });
    expect(yield* h.fs.readDirectory(h.path.dirname(h.destination))).toEqual([]);
  }).pipe(Effect.scoped, Effect.provide(dependencies)),
);
