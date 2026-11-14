import {
  checkTeamCatalogProposal,
  isTeamCatalogSource,
  TEAM_CATALOG_PROJECTS_DIRECTORY,
  TeamCatalogError,
  type TeamCatalogCheckout,
  type TeamCatalogProposal,
  type TeamCatalogProposeInput,
  type TeamCatalogRefreshInput,
  type TeamCatalogSnapshot,
  type TeamCatalogViewer,
  teamCatalogRepositoryKey,
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
import * as TeamCatalogAccess from "./TeamCatalogAccess.ts";
import { hostedRepositoryOf, proposalFileText, proposalText } from "./teamCatalogProposal.ts";
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
    /**
     * Pushes a parent and links change to the catalog remote as a new branch, with the user's own
     * git credentials, and opens a pull request when the remote is hosted. Never writes the
     * local catalog: the change counts once the catalog repository merges it.
     */
    readonly propose: (
      input: TeamCatalogProposeInput,
    ) => Effect.Effect<TeamCatalogProposal, TeamCatalogError>;
  }
>()("t3/teamCatalog/TeamCatalog") {}

const FETCH_TIMEOUT = "90 seconds";
const FRESH_FOR_MS = 30_000;
const MAX_ERROR_LENGTH = 500;
const REACHABILITY_FRESH_FOR_MS = 15 * 60_000;
const NO_VIEWER: TeamCatalogViewer = { login: null, problem: null };

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
  viewer: NO_VIEWER,
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
  const access = yield* TeamCatalogAccess.TeamCatalogAccess;
  const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
  const env = {
    ...unsetInheritedRepositoryEnv(process.env, yield* HostProcess.Platform),
    // No terminal can answer a credential prompt; fail instead of waiting for the timeout.
    GIT_TERMINAL_PROMPT: "0",
  };

  const root = path.join(config.stateDir, "team-catalog");
  const sourcePath = path.join(root, "source.json");
  const checkoutPath = path.join(root, "checkout");

  const git = (
    args: ReadonlyArray<string>,
    options: { readonly env?: Record<string, string>; readonly stdin?: string } = {},
  ) =>
    processRunner
      .run({
        command: "git",
        args,
        env: { ...env, ...options.env },
        timeout: FETCH_TIMEOUT,
        ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
      })
      .pipe(
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
  const viewerRef = yield* Ref.make<TeamCatalogViewer>(NO_VIEWER);
  const reachableRef = yield* Ref.make<
    ReadonlyMap<string, { readonly reachable: boolean; readonly checkedAt: number }>
  >(new Map());
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
    const reachability = yield* Ref.get(reachableRef);
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
                  reachable:
                    checkout.state === "present"
                      ? true
                      : (reachability.get(teamCatalogRepositoryKey(project.repo))?.reachable ??
                        null),
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
      viewer: source === null ? NO_VIEWER : yield* Ref.get(viewerRef),
    };
    yield* SubscriptionRef.set(state, next);
    return next;
  });

  // The GitHub login does not depend on the catalog host, so a cached catalog loads it too.
  const loadViewer = Effect.fn("TeamCatalog.loadViewer")(function* (force: boolean) {
    const viewer = yield* Ref.get(viewerRef);
    if (force || viewer.login === null) yield* Ref.set(viewerRef, yield* access.viewer);
  });

  // Runs only after a fetch succeeds, so a failed check means no access rather than no network.
  const checkReachability = Effect.fn("TeamCatalog.checkReachability")(function* (
    source: string,
    now: number,
    force: boolean,
  ) {
    const known = yield* Ref.get(reachableRef);
    const catalog = yield* Ref.get(catalogRef);
    const checked = yield* Effect.forEach(
      catalog.projects,
      ({ project }) => {
        const key = teamCatalogRepositoryKey(project.repo);
        const previous = known.get(key);
        if (
          !force &&
          previous !== undefined &&
          now - previous.checkedAt < REACHABILITY_FRESH_FOR_MS
        ) {
          return Effect.succeed([key, previous] as const);
        }
        return access
          .canReach(teamCatalogCloneUrl(project.repo, source))
          .pipe(Effect.map((reachable) => [key, { reachable, checkedAt: now }] as const));
      },
      { concurrency: 6 },
    );
    yield* Ref.set(reachableRef, new Map(checked));
  });

  const refreshUnlocked = Effect.fn("TeamCatalog.refresh")(function* (
    input: TeamCatalogRefreshInput | undefined,
  ) {
    const current = yield* SubscriptionRef.get(state);
    if (current.source === null) return yield* publish({});
    const now = yield* Clock.currentTimeMillis;
    const lastFetch = yield* Ref.get(fetchedAtMs);
    if (input?.force !== true && lastFetch !== null && now - lastFetch < FRESH_FOR_MS) {
      yield* loadViewer(false);
      return yield* publish({});
    }
    yield* SubscriptionRef.set(state, { ...current, refreshing: true });
    const fetched = yield* Effect.exit(fetchCatalog(current.source));
    if (Exit.isSuccess(fetched)) {
      // Freshness counts from when the fetch finished, not from when it started.
      const fetchedAt = yield* Clock.currentTimeMillis;
      yield* Ref.set(catalogRef, fetched.value.catalog);
      yield* Ref.set(fetchedAtMs, fetchedAt);
      yield* loadViewer(input?.force === true);
      yield* checkReachability(current.source, fetchedAt, input?.force === true);
      return yield* publish({
        refreshing: false,
        error: null,
        revision: fetched.value.revision,
        fetchedAt: DateTime.formatIso(DateTime.makeUnsafe(fetchedAt)),
      });
    }
    const failure = Exit.findErrorOption(fetched);
    yield* loadViewer(false);
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
          yield* Ref.set(reachableRef, new Map());
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

  const propose = Effect.fn("TeamCatalog.propose")(function* (input: TeamCatalogProposeInput) {
    const current = yield* SubscriptionRef.get(state);
    if (current.source === null) {
      return yield* new TeamCatalogError({ detail: "No team catalog is set." });
    }
    const source = current.source;
    if (current.revision !== input.baseRevision) {
      return yield* new TeamCatalogError({
        detail: "The team catalog changed since you opened it. Review the project and save again.",
      });
    }
    // Ownership is checked against the live login, never the one cached for display.
    const viewer = yield* access.viewer;
    yield* Ref.set(viewerRef, viewer);
    const catalog = yield* Ref.get(catalogRef);
    const projects = catalog.projects.map((entry) => entry.project);
    const refusal = checkTeamCatalogProposal(projects, input.changes, viewer.login);
    if (refusal !== null) return yield* new TeamCatalogError({ detail: refusal });

    const fileOf = new Map(catalog.projects.map((entry) => [entry.project.key, entry.file]));
    const failed = (detail: string) =>
      new TeamCatalogError({ detail: detail.slice(0, MAX_ERROR_LENGTH) });
    const author = yield* access.author;
    const authorEnv = {
      GIT_AUTHOR_NAME: author.name,
      GIT_AUTHOR_EMAIL: author.email,
      GIT_COMMITTER_NAME: author.name,
      GIT_COMMITTER_EMAIL: author.email,
    };
    const index = path.join(root, `proposal-${input.baseRevision.slice(0, 12)}.index`);
    const indexEnv = { GIT_INDEX_FILE: index };
    const commit = yield* Effect.gen(function* () {
      yield* git(["-C", checkoutPath, "read-tree", input.baseRevision], { env: indexEnv });
      for (const change of input.changes) {
        const file = fileOf.get(change.key)!;
        const original = yield* git(["-C", checkoutPath, "show", `${input.baseRevision}:${file}`]);
        const blob = yield* git(["-C", checkoutPath, "hash-object", "-w", "--stdin"], {
          stdin: proposalFileText(original, change),
        });
        yield* git(["-C", checkoutPath, "update-index", "--cacheinfo", `100644,${blob},${file}`], {
          env: indexEnv,
        });
      }
      const tree = yield* git(["-C", checkoutPath, "write-tree"], { env: indexEnv });
      const text = proposalText(projects, input.changes);
      const message = `${text.title}\n\n${text.body}\n`;
      // No terminal can unlock a signing key, and the catalog's pull request carries the review.
      const sha = yield* git(
        [
          "-C",
          checkoutPath,
          "commit-tree",
          "--no-gpg-sign",
          tree,
          "-p",
          input.baseRevision,
          "-F",
          "-",
        ],
        { stdin: message, env: authorEnv },
      );
      return { sha, text };
    }).pipe(
      Effect.ensuring(fileSystem.remove(index).pipe(Effect.ignore)),
      Effect.mapError((cause) => failed(`The change could not be committed: ${cause.detail}`)),
    );

    const branch = `${commit.text.branchStem}-${commit.sha.slice(0, 7)}`;
    yield* git([
      "-C",
      checkoutPath,
      "push",
      "--quiet",
      "--",
      source,
      `${commit.sha}:refs/heads/${branch}`,
    ]).pipe(Effect.mapError((cause) => failed(`The branch could not be pushed: ${cause.detail}`)));
    const repository = hostedRepositoryOf(source);
    const pullRequest =
      repository === null
        ? { url: null, problem: null }
        : yield* access
            .openPullRequest({
              repository,
              branch,
              title: commit.text.title,
              body: commit.text.body,
            })
            .pipe(
              Effect.map((url) => ({ url, problem: null })),
              Effect.catch((error) => Effect.succeed({ url: null, problem: error.detail })),
            );
    return {
      branch,
      commit: commit.sha,
      remote: source,
      files: input.changes.map((change) => fileOf.get(change.key)!),
      pullRequestUrl: pullRequest.url,
      pullRequestProblem: pullRequest.problem,
    } satisfies TeamCatalogProposal;
  }, lock.withPermits(1));

  return TeamCatalog.of({
    snapshot: SubscriptionRef.get(state),
    changes,
    refresh,
    setSource,
    propose,
  });
});

/** Without the live credential checks, for tests that provide their own `TeamCatalogAccess`. */
export const layerWithoutAccess = Layer.effect(TeamCatalog, make);

export const layer = layerWithoutAccess.pipe(Layer.provide(TeamCatalogAccess.layer));
