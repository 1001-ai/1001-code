import {
  isTeamCatalogSource,
  TEAM_CATALOG_PROJECTS_DIRECTORY,
  TeamCatalogError,
  type TeamCatalogCheckout,
  type TeamCatalogRefreshInput,
  type TeamCatalogSnapshot,
  teamCatalogRepositoryMatches,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as ServerSettings from "../serverSettings.ts";
import { unsetInheritedRepositoryEnv } from "../vcs/VcsProcess.ts";
import {
  type DecodedTeamCatalog,
  decodeTeamCatalogFiles,
  teamCatalogCheckoutFolder,
  teamCatalogCloneUrl,
} from "./teamCatalogFiles.ts";

/**
 * The team project catalog this environment reads: a git repository fetched with the
 * environment's own git credentials into T3 home, kept for offline use, and refreshed when a
 * client opens it or asks.
 */
export class TeamCatalog extends Context.Service<
  TeamCatalog,
  {
    readonly snapshot: Effect.Effect<TeamCatalogSnapshot>;
    /** The current snapshot, then every change. Subscribing refreshes a stale catalog. */
    readonly changes: Stream.Stream<TeamCatalogSnapshot>;
    /** Fetches when forced or stale, and always re-reads which projects are checked out. */
    readonly refresh: (input?: TeamCatalogRefreshInput) => Effect.Effect<TeamCatalogSnapshot>;
    readonly setSource: (
      source: string | null,
    ) => Effect.Effect<TeamCatalogSnapshot, TeamCatalogError>;
  }
>()("t3/teamCatalog/TeamCatalog") {}

const FETCH_TIMEOUT = "90 seconds";
const FRESH_FOR_MS = 30_000;
const MAX_ERROR_LENGTH = 500;

const SourceFile = Schema.fromJsonString(Schema.Struct({ source: Schema.String }));
const decodeSourceFile = Schema.decodeUnknownOption(SourceFile);
const encodeSourceFile = Schema.encodeSync(SourceFile);

const EMPTY_CATALOG: DecodedTeamCatalog = { projects: [], invalid: [] };

const emptySnapshot = (source: string | null): TeamCatalogSnapshot => ({
  source,
  revision: null,
  fetchedAt: null,
  refreshing: false,
  error: null,
  projects: [],
  invalid: [],
});

class GitFailure extends Schema.TaggedError<GitFailure>()("GitFailure", {
  detail: Schema.String,
}) {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const identities = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
  const settings = yield* ServerSettings.ServerSettingsService;
  const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
  const env = {
    ...unsetInheritedRepositoryEnv(process.env, yield* HostProcess.Platform),
    // No terminal can answer a credential prompt; fail instead of waiting for the timeout.
    GIT_TERMINAL_PROMPT: "0",
  };

  const root = path.join(config.stateDir, "team-catalog");
  const sourcePath = path.join(root, "source.json");
  const checkoutPath = path.join(root, "checkout");

  const git = (args: ReadonlyArray<string>) =>
    processRunner.run({ command: "git", args, env, timeout: FETCH_TIMEOUT }).pipe(
      Effect.mapError((cause) => new GitFailure({ detail: cause.message })),
      Effect.flatMap((output) =>
        output.code === 0
          ? Effect.succeed(output.stdout.trim())
          : Effect.fail(
              new GitFailure({
                detail: (output.stderr.trim() || `git ${args[2] ?? ""} failed.`).slice(
                  0,
                  MAX_ERROR_LENGTH,
                ),
              }),
            ),
      ),
    );

  const readCatalog = Effect.fn("TeamCatalog.readCatalog")(function* () {
    const directory = path.join(checkoutPath, TEAM_CATALOG_PROJECTS_DIRECTORY);
    const names = yield* fileSystem
      .readDirectory(directory)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
    const files = yield* Effect.forEach(
      names.filter((name) => name.endsWith(".json")),
      (name) =>
        fileSystem.readFileString(path.join(directory, name)).pipe(
          Effect.orElseSucceed(() => ""),
          Effect.map((text) => ({ file: `${TEAM_CATALOG_PROJECTS_DIRECTORY}/${name}`, text })),
        ),
      { concurrency: 8 },
    );
    return decodeTeamCatalogFiles(files);
  });

  const fetchCatalog = Effect.fn("TeamCatalog.fetchCatalog")(function* (source: string) {
    const hasRepository = yield* fileSystem
      .exists(path.join(checkoutPath, ".git"))
      .pipe(Effect.orElseSucceed(() => false));
    if (!hasRepository) {
      yield* fileSystem
        .makeDirectory(checkoutPath, { recursive: true })
        .pipe(Effect.mapError((cause) => new GitFailure({ detail: cause.message })));
      yield* git(["init", "--quiet", checkoutPath]);
    }
    yield* git([
      "-C",
      checkoutPath,
      "fetch",
      "--quiet",
      "--depth=1",
      "--no-tags",
      "--",
      source,
      "HEAD",
    ]);
    yield* git(["-C", checkoutPath, "checkout", "--quiet", "--force", "--detach", "FETCH_HEAD"]);
    const revision = yield* git(["-C", checkoutPath, "rev-parse", "HEAD"]);
    return { revision, catalog: yield* readCatalog() };
  });

  const checkoutFor = Effect.fn("TeamCatalog.checkoutFor")(function* (
    repo: string,
    ghqLayout: boolean,
  ) {
    const checkout = path.join(
      folders.namedProjectsRoot,
      ...teamCatalogCheckoutFolder(repo, ghqLayout),
    );
    const state = yield* Effect.gen(function* () {
      const info = yield* fileSystem.stat(checkout);
      if (info.type !== "Directory") return "occupied" as const;
      if ((yield* fileSystem.readDirectory(checkout)).length === 0) return "missing" as const;
      const identity = yield* identities.resolve(checkout, { refresh: true });
      if (!teamCatalogRepositoryMatches(repo, identity)) return "occupied" as const;
      // Git's empty prefix says the folder is the work tree's root, without comparing paths
      // that Windows spells differently (slashes, 8.3 names).
      const prefix = yield* git(["-C", checkout, "rev-parse", "--show-prefix"]);
      return prefix === "" ? ("present" as const) : ("occupied" as const);
    }).pipe(
      Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed("missing" as const)),
      Effect.orElseSucceed(() => "occupied" as const),
    );
    return { path: checkout, state } satisfies TeamCatalogCheckout;
  });

  const loadSource = fileSystem.readFileString(sourcePath).pipe(
    Effect.map((text) => decodeSourceFile(text)),
    Effect.map((decoded) =>
      decoded._tag === "Some" && isTeamCatalogSource(decoded.value.source)
        ? decoded.value.source
        : null,
    ),
    Effect.orElseSucceed(() => null),
  );

  const initialSource = yield* loadSource;
  const catalogRef = yield* Ref.make<DecodedTeamCatalog>(
    initialSource === null ? EMPTY_CATALOG : yield* readCatalog(),
  );
  const fetchedAtMs = yield* Ref.make<number | null>(null);
  const state = yield* SubscriptionRef.make(emptySnapshot(initialSource));
  const lock = yield* Semaphore.make(1);
  const backgroundScope = yield* Scope.make();
  yield* Effect.addFinalizer(() => Scope.close(backgroundScope, Exit.void));

  const publish = Effect.fn("TeamCatalog.publish")(function* (
    fields: Partial<TeamCatalogSnapshot>,
  ) {
    const current = yield* SubscriptionRef.get(state);
    const source = fields.source === undefined ? current.source : fields.source;
    const catalog = yield* Ref.get(catalogRef);
    const ghqLayout = yield* settings.getSettings.pipe(
      Effect.map((value) => value.ghqCloneLayout),
      Effect.orElseSucceed(() => false),
    );
    const projects =
      source === null
        ? []
        : yield* Effect.forEach(
            catalog.projects,
            ({ file, project }) =>
              checkoutFor(project.repo, ghqLayout).pipe(
                Effect.map((checkout) => ({
                  file,
                  project,
                  cloneUrl: teamCatalogCloneUrl(project.repo, source),
                  checkout,
                })),
              ),
            { concurrency: 4 },
          );
    const next: TeamCatalogSnapshot = {
      ...current,
      ...fields,
      source,
      projects,
      invalid: source === null ? [] : catalog.invalid,
    };
    yield* SubscriptionRef.set(state, next);
    return next;
  });

  const refreshUnlocked = Effect.fn("TeamCatalog.refresh")(function* (
    input: TeamCatalogRefreshInput | undefined,
  ) {
    const current = yield* SubscriptionRef.get(state);
    if (current.source === null) return yield* publish({});
    const now = yield* Clock.currentTimeMillis;
    const lastFetch = yield* Ref.get(fetchedAtMs);
    if (input?.force !== true && lastFetch !== null && now - lastFetch < FRESH_FOR_MS) {
      return yield* publish({});
    }
    yield* SubscriptionRef.set(state, { ...current, refreshing: true });
    const fetched = yield* Effect.exit(fetchCatalog(current.source));
    if (Exit.isSuccess(fetched)) {
      yield* Ref.set(catalogRef, fetched.value.catalog);
      yield* Ref.set(fetchedAtMs, now);
      return yield* publish({
        refreshing: false,
        error: null,
        revision: fetched.value.revision,
        fetchedAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
      });
    }
    const failure = Exit.findErrorOption(fetched);
    return yield* publish({
      refreshing: false,
      error:
        failure._tag === "Some" ? failure.value.detail : "The team catalog could not be fetched.",
    });
  });

  const refresh: TeamCatalog["Service"]["refresh"] = (input) =>
    lock.withPermits(1)(refreshUnlocked(input));

  const setSource: TeamCatalog["Service"]["setSource"] = Effect.fn("TeamCatalog.setSource")(
    function* (source) {
      if (source !== null && !isTeamCatalogSource(source)) {
        return yield* new TeamCatalogError({
          detail:
            "Enter a git URL, such as https://host/owner/repo.git or git@host:owner/repo.git.",
        });
      }
      yield* lock.withPermits(1)(
        Effect.gen(function* () {
          if ((yield* SubscriptionRef.get(state)).source === source) return;
          yield* fileSystem.remove(checkoutPath, { recursive: true }).pipe(Effect.ignore);
          if (source === null) {
            yield* fileSystem.remove(sourcePath).pipe(Effect.ignore);
          } else {
            yield* fileSystem.makeDirectory(root, { recursive: true }).pipe(
              Effect.andThen(fileSystem.writeFileString(sourcePath, encodeSourceFile({ source }))),
              Effect.mapError(
                (cause) =>
                  new TeamCatalogError({
                    detail: `The team catalog setting could not be saved: ${cause.message}`,
                  }),
              ),
            );
          }
          yield* Ref.set(catalogRef, EMPTY_CATALOG);
          yield* Ref.set(fetchedAtMs, null);
          yield* SubscriptionRef.set(state, emptySnapshot(source));
        }),
      );
      return yield* refresh({ force: true });
    },
  );

  const changes = Stream.unwrap(
    refresh().pipe(Effect.forkIn(backgroundScope), Effect.as(SubscriptionRef.changes(state))),
  );

  // Serve the last fetch at once, dated by git's own FETCH_HEAD, so a restart or an offline start
  // shows the catalog right away and only refetches when it is stale.
  const restoreCachedCatalog = Effect.fn("TeamCatalog.restoreCachedCatalog")(function* () {
    const fetchedAt = yield* fileSystem.stat(path.join(checkoutPath, ".git", "FETCH_HEAD")).pipe(
      Effect.map((info) => Option.getOrNull(info.mtime)?.getTime() ?? null),
      Effect.orElseSucceed(() => null),
    );
    if (fetchedAt === null) return;
    yield* Ref.set(fetchedAtMs, fetchedAt);
    const revision = yield* git(["-C", checkoutPath, "rev-parse", "HEAD"]).pipe(
      Effect.orElseSucceed(() => null),
    );
    yield* publish({ revision, fetchedAt: DateTime.formatIso(DateTime.makeUnsafe(fetchedAt)) });
  });

  if (initialSource !== null) {
    yield* lock
      .withPermits(1)(restoreCachedCatalog())
      .pipe(Effect.andThen(refresh()), Effect.forkIn(backgroundScope));
  }

  return TeamCatalog.of({
    snapshot: SubscriptionRef.get(state),
    changes,
    refresh,
    setSource,
  });
});

export const layer = Layer.effect(TeamCatalog, make);
