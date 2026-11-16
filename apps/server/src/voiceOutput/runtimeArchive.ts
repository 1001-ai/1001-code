import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

export class RuntimeArchiveError extends Schema.TaggedError<RuntimeArchiveError>()(
  "RuntimeArchiveError",
  {
    stage: Schema.Literals(["listing", "entry", "extraction", "contents"]),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    return `The speech runtime archive was refused (${this.stage}).`;
  }
}

/** Whether an archive entry would land outside the folder it is extracted into. */
export function isUnsafeArchiveEntry(entry: string): boolean {
  return (
    entry.length === 0 ||
    entry.includes("\0") ||
    entry.includes("\\") ||
    entry.startsWith("/") ||
    /^[A-Za-z]:/.test(entry) ||
    entry.split("/").includes("..")
  );
}

/**
 * Installs a verified runtime archive as `destination`. It is listed and checked before anything
 * is written, extracted into a fresh staging folder, checked again as extracted (only files,
 * folders and links that stay inside), and only then renamed into place.
 */
export const makeRuntimeArchiveExtractor = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const random = yield* SecureRandom.SecureRandom;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  // System tar reads .tar.gz on macOS and Linux and .zip on Windows 10 and later.
  const tar = Effect.fn("voiceOutput.tar")(
    function* (stage: "listing" | "extraction", args: ReadonlyArray<string>) {
      const child = yield* spawner.spawn(
        ChildProcess.make("tar", args, { stdin: "ignore", stdout: "pipe", stderr: "ignore" }),
      );
      const [stdout, exitCode] = yield* Effect.all(
        [Stream.mkString(Stream.decodeText(child.stdout)), child.exitCode],
        { concurrency: 2 },
      );
      if (exitCode !== 0) return yield* new RuntimeArchiveError({ stage });
      return stdout;
    },
    Effect.scoped,
    Effect.mapError((cause) =>
      cause._tag === "RuntimeArchiveError"
        ? cause
        : new RuntimeArchiveError({ stage: "extraction", cause }),
    ),
  );

  const checkTree = Effect.fn("voiceOutput.checkExtractedTree")(function* (root: string) {
    const pending = [root];
    while (pending.length > 0) {
      const directory = pending.pop()!;
      for (const name of yield* fs.readDirectory(directory)) {
        const entry = path.join(directory, name);
        const link = yield* fs.readLink(entry).pipe(Effect.option);
        if (Option.isSome(link)) {
          const target = path.resolve(directory, link.value);
          if (target !== root && !target.startsWith(root + path.sep))
            return yield* new RuntimeArchiveError({ stage: "contents" });
          continue;
        }
        const info = yield* fs.stat(entry);
        if (info.type === "Directory") pending.push(entry);
        else if (info.type !== "File") return yield* new RuntimeArchiveError({ stage: "contents" });
      }
    }
  });

  return Effect.fn("voiceOutput.extractRuntimeArchive")(function* (input: {
    readonly archivePath: string;
    readonly destination: string;
    /** The library's path inside the archive; it must be a real file, not a link. */
    readonly library: string;
    /** Written last as `.t3-complete`, so a folder without it is an interrupted extraction. */
    readonly version: string;
  }) {
    const entries = (yield* tar("listing", ["-tf", input.archivePath]))
      .split(/\r?\n/)
      .filter((entry) => entry.length > 0);
    if (entries.length === 0 || entries.some(isUnsafeArchiveEntry))
      return yield* new RuntimeArchiveError({ stage: "entry" });

    const staging = `${input.destination}.${yield* random.uuidV4()}.part`;
    yield* Effect.gen(function* () {
      yield* fs.makeDirectory(staging, { recursive: true });
      yield* tar("extraction", ["-xf", input.archivePath, "-C", staging]);
      yield* checkTree(staging);
      const library = path.join(staging, input.library);
      const isLink = Option.isSome(yield* fs.readLink(library).pipe(Effect.option));
      if (isLink || (yield* fs.stat(library)).type !== "File")
        return yield* new RuntimeArchiveError({ stage: "contents" });
      yield* fs.writeFileString(path.join(staging, ".t3-complete"), input.version);
      yield* fs.remove(input.destination, { recursive: true, force: true });
      yield* fs.rename(staging, input.destination);
    }).pipe(
      Effect.mapError((cause) =>
        cause._tag === "RuntimeArchiveError"
          ? cause
          : new RuntimeArchiveError({ stage: "contents", cause }),
      ),
      Effect.onExit((exit) =>
        Exit.isSuccess(exit)
          ? Effect.void
          : fs.remove(staging, { recursive: true, force: true }).pipe(Effect.ignore),
      ),
    );
  });
});
