import {
  AGENTS_BOARD_DEFAULT_BRANCH,
  AGENTS_BOARD_INBOX_DIRECTORY,
  AGENTS_BOARD_MEDIA_MAX_BYTES,
  AGENTS_BOARD_REPORTS_DIRECTORY,
  type AgentsBoardData,
  AgentsBoardError,
  type AgentsBoardMedia,
  type AgentsBoardMediaInput,
  type AgentsBoardProject,
  type AgentsBoardSetBranchInput,
  type AgentsBoardSnapshot,
  agentsBoardMediaType,
  isAgentsBoardBranch,
  type ProjectId,
  teamCatalogRepositoryKey,
  teamCatalogRepositoryMatches,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as TeamCatalog from "../teamCatalog/TeamCatalog.ts";
import { unsetInheritedRepositoryEnv } from "../vcs/VcsProcess.ts";
import {
  AGENTS_BOARD_LIMITS,
  type AgentsBoardFile,
  agentsBoardFileKind,
  buildAgentsBoard,
} from "./agentsBoardFiles.ts";
import { imageTypeOf } from "./agentsBoardMedia.ts";

/**
 * The agents board of a team project: the messages agents write to a branch of the project's
 * repository. The branch is fetched with the environment's own git credentials into a bare
 * repository in the state directory and read with git plumbing, so nothing on it is checked out
 * or run. It is fetched when a client opens the board or asks, never in the background.
 */
export class AgentsBoard extends Context.Service<
  AgentsBoard,
  {
    /** What the last fetch left; never reaches the network. */
    readonly read: (projectId: ProjectId) => Effect.Effect<AgentsBoardSnapshot>;
    /** The board now, then every change. Subscribing fetches a branch not fetched lately. */
    readonly changes: (projectId: ProjectId) => Stream.Stream<AgentsBoardSnapshot>;
    readonly refresh: (projectId: ProjectId) => Effect.Effect<AgentsBoardSnapshot>;
    /** Names the branch for the project's repository on this environment, then fetches it. */
    readonly setBranch: (
      input: AgentsBoardSetBranchInput,
    ) => Effect.Effect<AgentsBoardSnapshot, AgentsBoardError>;
    /** One image under `media/` on the fetched branch. */
    readonly media: (
      input: AgentsBoardMediaInput,
    ) => Effect.Effect<AgentsBoardMedia, AgentsBoardError>;
  }
>()("t3/agentsBoard/AgentsBoard") {}

const GIT_TIMEOUT = "60 seconds";
const FRESH_FOR_MS = 30_000;
const MAX_FAILURE_LENGTH = 300;
const MAX_LISTING_BYTES = 1024 * 1024;
const REGULAR_FILE_MODES: ReadonlySet<string> = new Set(["100644", "100755"]);

// Branch names by repository key. Kept beside the cache, not in the server settings, so no
// settings schema changes.
const SettingsFile = Schema.fromJsonString(
  Schema.Struct({ branches: Schema.Record(Schema.String, Schema.String) }),
);
const decodeSettingsFile = Schema.decodeUnknownOption(SettingsFile);
const encodeSettingsFile = Schema.encodeSync(SettingsFile);

class GitFailure extends Schema.TaggedError<GitFailure>()("GitFailure", {
  detail: Schema.String,
}) {}

interface Target {
  readonly project: AgentsBoardProject;
  readonly repositoryKey: string;
  readonly cloneUrl: string;
  readonly branch: string;
  /** The bare repository in the state directory that holds the fetched branch. */
  readonly cache: string;
}

interface BranchState {
  readonly lock: Semaphore.Semaphore;
  /** The cache on disk has been read since the server started. */
  loaded: boolean;
  refreshing: boolean;
  /** When a fetch last finished, whatever its result; null before the first. */
  checkedAtMs: number | null;
  /** How many fetches have finished. */
  completed: number;
  missing: boolean;
  failure: string | null;
  board: { readonly data: AgentsBoardData; readonly fetchedAtMs: number } | null;
}

interface TreeEntry {
  readonly mode: string;
  readonly type: string;
  readonly sha: string;
  readonly size: number;
  readonly path: string;
}

/** `git ls-tree -r -l -z` records: `<mode> <type> <sha> <size>\t<path>`. */
function treeEntries(listing: string): ReadonlyArray<TreeEntry> {
  const entries: Array<TreeEntry> = [];
  for (const record of listing.split("\u0000")) {
    const match = /^(\d{6}) (\w+) ([0-9a-f]{40,64}) +(\d+|-)\t(.+)$/s.exec(record);
    if (match === null) continue;
    entries.push({
      mode: match[1]!,
      type: match[2]!,
      sha: match[3]!,
      size: match[4] === "-" ? 0 : Number(match[4]),
      path: match[5]!,
    });
  }
  return entries;
}

/** `git cat-file --batch` output: `<sha> blob <size>\n<bytes>\n` for each object asked for. */
function batchedBlobs(output: Buffer): ReadonlyMap<string, string> {
  const blobs = new Map<string, string>();
  const decoder = new TextDecoder();
  let offset = 0;
  while (offset < output.length) {
    const lineEnd = output.indexOf(0x0a, offset);
    if (lineEnd === -1) break;
    const header = /^([0-9a-f]{40,64}) blob (\d+)$/.exec(
      output.toString("latin1", offset, lineEnd),
    );
    if (header === null) break;
    const start = lineEnd + 1;
    const end = start + Number(header[2]);
    if (end > output.length) break;
    blobs.set(header[1]!, decoder.decode(output.subarray(start, end)));
    offset = end + 1;
  }
  return blobs;
}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const teamCatalog = yield* TeamCatalog.TeamCatalog;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const identities = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
  const digest = yield* Digest.Digest;
  const env = {
    ...unsetInheritedRepositoryEnv(process.env, yield* HostProcess.Platform),
    // No terminal can answer a credential prompt; fail instead of waiting for the timeout.
    GIT_TERMINAL_PROMPT: "0",
    // The fetch's own words say whether a branch is missing; without it git follows the system language.
    LANGUAGE: "C",
  };

  const root = path.join(config.stateDir, "agents-board");
  const settingsPath = path.join(root, "settings.json");
  const settingsLock = yield* Semaphore.make(1);
  let branches: Record<string, string> = yield* fileSystem.readFileString(settingsPath).pipe(
    Effect.map(decodeSettingsFile),
    Effect.map((file) => (Option.isSome(file) ? file.value.branches : {})),
    Effect.orElseSucceed(() => ({})),
  );

  const states = new Map<string, BranchState>();
  const signals = yield* PubSub.unbounded<void>();
  const backgroundScope = yield* Scope.make();
  yield* Effect.addFinalizer(() => Scope.close(backgroundScope, Exit.void));

  const refOf = (target: Target) => `refs/heads/${target.branch}`;

  // Untraced: a map lookup inside every read, already under that read's span.
  const stateOf = Effect.fnUntraced(function* (target: Target) {
    const key = `${target.repositoryKey}\u0000${target.branch}`;
    const known = states.get(key);
    if (known !== undefined) return known;
    const created: BranchState = {
      lock: yield* Semaphore.make(1),
      loaded: false,
      refreshing: false,
      checkedAtMs: null,
      completed: 0,
      missing: false,
      failure: null,
      board: null,
    };
    // Another fiber may have made it while this one made its lock.
    const raced = states.get(key);
    if (raced !== undefined) return raced;
    states.set(key, created);
    return created;
  });

  const run = (
    args: ReadonlyArray<string>,
    options: {
      readonly stdin?: string;
      readonly onStdoutChunk?: (chunk: Uint8Array) => void;
      readonly maxOutputBytes?: number;
    } = {},
  ) =>
    processRunner
      .run({
        command: "git",
        args,
        env,
        timeout: GIT_TIMEOUT,
        outputMode: "truncate",
        ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
        ...(options.onStdoutChunk === undefined ? {} : { onStdoutChunk: options.onStdoutChunk }),
        ...(options.maxOutputBytes === undefined ? {} : { maxOutputBytes: options.maxOutputBytes }),
      })
      .pipe(Effect.mapError((cause) => new GitFailure({ detail: cause.message })));

  const failureText = (stderr: string, fallback: string) =>
    (stderr.trim() || fallback).slice(0, MAX_FAILURE_LENGTH);

  /** Stdout as bytes, or null when it is more than `maxBytes` or git fails. */
  const gitBytes = Effect.fn("AgentsBoard.gitBytes")(function* (
    args: ReadonlyArray<string>,
    maxBytes: number,
    stdin?: string,
  ) {
    const chunks: Array<Uint8Array> = [];
    let bytes = 0;
    let overflow = false;
    const output = yield* run(args, {
      ...(stdin === undefined ? {} : { stdin }),
      // The runner's own copy is text, which would mangle bytes; keep it small.
      maxOutputBytes: 1024,
      onStdoutChunk: (chunk) => {
        if (overflow) return;
        if (bytes + chunk.byteLength > maxBytes) {
          overflow = true;
          return;
        }
        chunks.push(chunk);
        bytes += chunk.byteLength;
      },
    });
    return output.code === 0 && !overflow ? Buffer.concat(chunks, bytes) : null;
  });

  const resolveTarget = Effect.fn("AgentsBoard.resolveTarget")(function* (projectId: ProjectId) {
    const catalog = yield* teamCatalog.snapshot;
    if (catalog.source === null) return "no-catalog" as const;
    const project = yield* projects
      .get(projectId)
      .pipe(Effect.orElseSucceed(() => Option.none<ProjectStore.ProjectRow>()));
    const identity = Option.isSome(project)
      ? yield* identities.resolve(project.value.workspaceRoot)
      : null;
    const entry = catalog.projects.find((candidate) =>
      teamCatalogRepositoryMatches(candidate.project.repo, identity),
    );
    if (entry === undefined) return "not-in-catalog" as const;
    const repositoryKey = teamCatalogRepositoryKey(entry.project.repo);
    const chosen = branches[repositoryKey];
    // The folder's name comes from a hash, so nothing the catalog says becomes a path.
    const hash = yield* digest.digestHex(Digest.sha256, new TextEncoder().encode(repositoryKey));
    return {
      cache: path.join(root, "repos", `${hash.slice(0, 32)}.git`),
      project: { key: entry.project.key, name: entry.project.name },
      repositoryKey,
      cloneUrl: entry.cloneUrl,
      // A hand-edited settings file gets the same check as the setting.
      branch:
        chosen !== undefined && isAgentsBoardBranch(chosen) ? chosen : AGENTS_BOARD_DEFAULT_BRANCH,
    } satisfies Target;
  });

  /** The board in the cache, or null when the cache has no such branch. */
  const readCache = Effect.fn("AgentsBoard.readCache")(function* (target: Target) {
    const cache = target.cache;
    const listing = yield* run(
      [
        "--git-dir",
        cache,
        "ls-tree",
        "-r",
        "-l",
        "-z",
        refOf(target),
        "--",
        AGENTS_BOARD_REPORTS_DIRECTORY,
        AGENTS_BOARD_INBOX_DIRECTORY,
      ],
      { maxOutputBytes: MAX_LISTING_BYTES },
    );
    if (listing.code !== 0) return null;
    let truncated = listing.stdoutTruncated;
    let totalBytes = 0;
    const perFolder = new Map<string, number>();
    const wanted: Array<TreeEntry> = [];
    for (const entry of treeEntries(listing.stdout)) {
      const kind = agentsBoardFileKind(entry.path);
      // A symlink or submodule in these folders is not a report.
      if (kind === null || entry.type !== "blob" || !REGULAR_FILE_MODES.has(entry.mode)) continue;
      const count = perFolder.get(kind.kind) ?? 0;
      if (
        count >= AGENTS_BOARD_LIMITS.maxFiles ||
        entry.size > AGENTS_BOARD_LIMITS.maxFileBytes ||
        totalBytes + entry.size > AGENTS_BOARD_LIMITS.maxTotalBytes
      ) {
        truncated = true;
        continue;
      }
      perFolder.set(kind.kind, count + 1);
      totalBytes += entry.size;
      wanted.push(entry);
    }
    const files: Array<AgentsBoardFile> = [];
    if (wanted.length > 0) {
      const output = yield* gitBytes(
        ["--git-dir", cache, "cat-file", "--batch"],
        // Each object adds a header line and a newline to its bytes.
        totalBytes + wanted.length * 128,
        `${wanted.map((entry) => entry.sha).join("\n")}\n`,
      );
      const blobs = output === null ? new Map<string, string>() : batchedBlobs(output);
      for (const entry of wanted) {
        const text = blobs.get(entry.sha);
        if (text === undefined) truncated = true;
        else files.push({ path: entry.path, text });
      }
    }
    return buildAgentsBoard(files, AGENTS_BOARD_LIMITS, truncated);
  });

  /** Reads what an earlier server run fetched; the caller holds the state's lock. */
  const loadCache = Effect.fn("AgentsBoard.loadCache")(function* (
    target: Target,
    state: BranchState,
  ) {
    if (state.loaded) return;
    state.loaded = true;
    const fetchedAtMs = yield* fileSystem.stat(path.join(target.cache, "FETCH_HEAD")).pipe(
      Effect.map((info) => Option.getOrNull(info.mtime)?.getTime() ?? null),
      Effect.orElseSucceed(() => null),
    );
    if (fetchedAtMs === null) return;
    const data = yield* readCache(target).pipe(Effect.orElseSucceed(() => null));
    if (data !== null) state.board = { data, fetchedAtMs };
  });

  const fetchBranch = Effect.fn("AgentsBoard.fetchBranch")(function* (target: Target) {
    const cache = target.cache;
    const hasCache = yield* fileSystem
      .exists(path.join(cache, "HEAD"))
      .pipe(Effect.orElseSucceed(() => false));
    if (!hasCache) {
      yield* fileSystem
        .makeDirectory(cache, { recursive: true })
        .pipe(Effect.mapError((cause) => new GitFailure({ detail: cause.message })));
      const init = yield* run(["init", "--quiet", "--bare", cache]);
      if (init.code !== 0) {
        return yield* new GitFailure({ detail: failureText(init.stderr, "git init failed.") });
      }
    }
    const ref = refOf(target);
    const fetched = yield* run([
      "--git-dir",
      cache,
      "fetch",
      "--quiet",
      "--depth=1",
      "--no-tags",
      "--no-recurse-submodules",
      "--force",
      "--",
      target.cloneUrl,
      `+${ref}:${ref}`,
    ]);
    if (fetched.code === 0) return "fetched" as const;
    if (/couldn't find remote ref/i.test(fetched.stderr)) return "missing" as const;
    // Other git versions word it differently: ask the remote, where exit 2 means no such ref.
    const listed = yield* run([
      "ls-remote",
      "--exit-code",
      "--quiet",
      "--",
      target.cloneUrl,
      ref,
    ]).pipe(Effect.option);
    if (Option.isSome(listed) && listed.value.code === 2) return "missing" as const;
    return yield* new GitFailure({
      detail: failureText(fetched.stderr, "The agents branch could not be fetched."),
    });
  });

  const snapshotOf = (target: Target, state: BranchState): AgentsBoardSnapshot => {
    const base = { project: target.project, branch: target.branch, refreshing: state.refreshing };
    if (state.missing) return { status: "missing-branch", ...base };
    if (state.board !== null) {
      return {
        status: "ready",
        ...base,
        board: state.board.data,
        fetchedAt: DateTime.formatIso(DateTime.makeUnsafe(state.board.fetchedAtMs)),
        failure: state.failure,
      };
    }
    if (state.failure !== null) return { status: "failed", ...base, failure: state.failure };
    return { status: "loading", ...base };
  };

  const publish = PubSub.publish(signals, undefined).pipe(Effect.asVoid);

  const refreshTarget = Effect.fn("AgentsBoard.refreshTarget")(function* (target: Target) {
    const state = yield* stateOf(target);
    const completedWhenAsked = state.completed;
    yield* state.lock.withPermits(1)(
      Effect.gen(function* () {
        // A fetch that finished while this one waited for the lock already answers it.
        if (state.completed > completedWhenAsked) {
          state.refreshing = false;
          return;
        }
        yield* loadCache(target, state);
        // Not published: the whole board would go to every open client again just to say so.
        state.refreshing = true;
        const outcome = yield* Effect.exit(
          fetchBranch(target).pipe(
            Effect.flatMap((result) =>
              result === "missing"
                ? Effect.succeed(null)
                : readCache(target).pipe(
                    Effect.filterOrFail(
                      (data) => data !== null,
                      () => new GitFailure({ detail: "The agents branch could not be read." }),
                    ),
                  ),
            ),
          ),
        );
        const now = yield* Clock.currentTimeMillis;
        state.refreshing = false;
        state.checkedAtMs = now;
        state.completed += 1;
        if (Exit.isSuccess(outcome)) {
          state.failure = null;
          state.missing = outcome.value === null;
          state.board = outcome.value === null ? null : { data: outcome.value, fetchedAtMs: now };
        } else {
          const failure = Exit.findErrorOption(outcome);
          state.missing = false;
          state.failure =
            failure._tag === "Some"
              ? failure.value.detail.slice(0, MAX_FAILURE_LENGTH)
              : "The agents branch could not be fetched.";
        }
        yield* publish;
      }),
    );
    return snapshotOf(target, state);
  });

  const read: AgentsBoard["Service"]["read"] = Effect.fn("AgentsBoard.read")(function* (projectId) {
    const target = yield* resolveTarget(projectId);
    if (typeof target === "string") return { status: "unavailable", reason: target };
    const state = yield* stateOf(target);
    // Waits only for the first read of a branch; a fetch in flight has loaded it already.
    if (!state.loaded) yield* state.lock.withPermits(1)(loadCache(target, state));
    return snapshotOf(target, state);
  });

  const refresh: AgentsBoard["Service"]["refresh"] = Effect.fn("AgentsBoard.refresh")(
    function* (projectId) {
      const target = yield* resolveTarget(projectId);
      if (typeof target === "string") return { status: "unavailable", reason: target };
      return yield* refreshTarget(target);
    },
  );

  const refreshWhenStale = Effect.fn("AgentsBoard.refreshWhenStale")(function* (
    projectId: ProjectId,
    staleAfterMs: number,
  ) {
    const target = yield* resolveTarget(projectId);
    if (typeof target === "string") return;
    const state = yield* stateOf(target);
    const now = yield* Clock.currentTimeMillis;
    if (state.refreshing) return;
    if (state.checkedAtMs !== null && now - state.checkedAtMs < staleAfterMs) return;
    // Claimed before the fork, so boards opened together start one fetch.
    state.refreshing = true;
    yield* refreshTarget(target).pipe(Effect.forkIn(backgroundScope));
  });

  // The board itself is compared by identity: it is replaced only by a fetch.
  const sameSnapshot = (left: AgentsBoardSnapshot, right: AgentsBoardSnapshot) => {
    const board = (snapshot: AgentsBoardSnapshot) =>
      snapshot.status === "ready" ? snapshot.board : null;
    const rest = (snapshot: AgentsBoardSnapshot) =>
      JSON.stringify(snapshot.status === "ready" ? { ...snapshot, board: null } : snapshot);
    return board(left) === board(right) && rest(left) === rest(right);
  };

  const changes: AgentsBoard["Service"]["changes"] = (projectId) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(signals);
        // The first read loads the cache, so the read after it never waits for the fetch.
        const readAndRefresh = (staleAfterMs: number) =>
          read(projectId).pipe(
            Effect.andThen(refreshWhenStale(projectId, staleAfterMs)),
            Effect.andThen(read(projectId)),
          );
        const opened = readAndRefresh(FRESH_FOR_MS);
        // The catalog may still be loading when a board opens, and decides which project this is.
        // Its later changes fetch only a branch never fetched, so an open board does not poll.
        const catalogChanged = readAndRefresh(Number.POSITIVE_INFINITY);
        return Stream.concat(
          Stream.fromEffect(opened),
          Stream.merge(
            Stream.fromSubscription(subscription).pipe(Stream.mapEffect(() => read(projectId))),
            teamCatalog.changes.pipe(Stream.mapEffect(() => catalogChanged)),
          ),
        ).pipe(Stream.changesWith(sameSnapshot));
      }),
    );

  const setBranch: AgentsBoard["Service"]["setBranch"] = Effect.fn("AgentsBoard.setBranch")(
    function* (input) {
      const target = yield* resolveTarget(input.projectId);
      if (typeof target === "string") {
        return yield* new AgentsBoardError({ reason: "not-a-team-project" });
      }
      yield* settingsLock.withPermits(1)(
        Effect.gen(function* () {
          const { [target.repositoryKey]: _previous, ...others } = branches;
          const next =
            input.branch === null || input.branch === AGENTS_BOARD_DEFAULT_BRANCH
              ? others
              : { ...others, [target.repositoryKey]: input.branch };
          yield* fileSystem.makeDirectory(root, { recursive: true }).pipe(
            Effect.andThen(
              fileSystem.writeFileString(settingsPath, encodeSettingsFile({ branches: next })),
            ),
            Effect.mapError(() => new AgentsBoardError({ reason: "settings-unsaved" })),
          );
          branches = next;
        }),
      );
      yield* publish;
      return yield* refresh(input.projectId);
    },
  );

  const media: AgentsBoard["Service"]["media"] = Effect.fn("AgentsBoard.media")(function* (input) {
    // The RPC schema checks the path too; other callers of the service get the same check.
    if (agentsBoardMediaType(input.path) === null) {
      return yield* new AgentsBoardError({ reason: "not-found" });
    }
    const target = yield* resolveTarget(input.projectId);
    if (typeof target === "string") {
      return yield* new AgentsBoardError({ reason: "not-a-team-project" });
    }
    const cache = target.cache;
    const listing = yield* run([
      "--git-dir",
      cache,
      "ls-tree",
      "-l",
      "-z",
      refOf(target),
      "--",
      input.path,
    ]).pipe(Effect.orElseSucceed(() => null));
    if (listing === null || listing.code !== 0) {
      return yield* new AgentsBoardError({ reason: "not-fetched" });
    }
    const entry = treeEntries(listing.stdout).find((candidate) => candidate.path === input.path);
    if (entry === undefined || entry.type !== "blob" || !REGULAR_FILE_MODES.has(entry.mode)) {
      return yield* new AgentsBoardError({ reason: "not-found" });
    }
    if (entry.size > AGENTS_BOARD_MEDIA_MAX_BYTES) {
      return yield* new AgentsBoardError({ reason: "too-large" });
    }
    const bytes = yield* gitBytes(
      ["--git-dir", cache, "cat-file", "blob", entry.sha],
      AGENTS_BOARD_MEDIA_MAX_BYTES,
    ).pipe(Effect.orElseSucceed(() => null));
    if (bytes === null) return yield* new AgentsBoardError({ reason: "not-found" });
    // The bytes decide the type, so a page or script named `.png` is never served as one.
    const mimeType = imageTypeOf(bytes);
    if (mimeType === null) return yield* new AgentsBoardError({ reason: "not-an-image" });
    return { mimeType, base64: bytes.toString("base64") };
  });

  return AgentsBoard.of({ read, changes, refresh, setBranch, media });
});

export const layer = Layer.effect(AgentsBoard, make);
