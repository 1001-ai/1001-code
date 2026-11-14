import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import { ChildProcessSpawner } from "effect/process";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as ServerSettings from "../serverSettings.ts";
import { TeamCatalogError } from "@t3tools/contracts";

import * as TeamCatalog from "./TeamCatalog.ts";
import * as TeamCatalogAccess from "./TeamCatalogAccess.ts";

const GIT_IDENTITY = {
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.test",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.test",
};

const git = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const runner = yield* ProcessRunner.ProcessRunner;
    const output = yield* runner.run({
      command: "git",
      args: ["-C", cwd, ...args],
      env: { ...process.env, ...GIT_IDENTITY },
    });
    expect(output.code, output.stderr).toBe(0);
  });

const project = (
  key: string,
  repo: string,
  extra: { readonly owners?: ReadonlyArray<string>; readonly links?: ReadonlyArray<unknown> } = {},
) => ({ key, name: key.toUpperCase(), repo, owners: [], ...extra });

/** Signed in as `login` (alice to start); repositories with "private" in their name are out of reach. */
const accessTest = (login: Ref.Ref<string>) =>
  Layer.mock(TeamCatalogAccess.TeamCatalogAccess)({
    viewer: Ref.get(login).pipe(Effect.map((current) => ({ login: current, problem: null }))),
    author: Effect.succeed({ name: "alice", email: "7+alice@users.noreply.github.com" }),
    canReach: (cloneUrl) => Effect.succeed(!cloneUrl.includes("private")),
    openPullRequest: () => Effect.fail(new TeamCatalogError({ detail: "No pull requests here." })),
  });

interface FetchHold {
  readonly started: Deferred.Deferred<void>;
  readonly release: Deferred.Deferred<void>;
}

type Services =
  | FileSystem.FileSystem
  | Path.Path
  | ProcessRunner.ProcessRunner
  | ChildProcessSpawner.ChildProcessSpawner;

/** A catalog repository, a projects folder, and a service reading them, all in a temp dir. */
const withCatalog = <A, E>(
  test: (fixture: {
    readonly catalog: string;
    readonly projectsRoot: string;
    readonly stateDir: string;
    readonly commit: (files: Record<string, unknown>) => Effect.Effect<void, Error>;
    readonly service: TeamCatalog.TeamCatalog["Service"];
    readonly start: Effect.Effect<TeamCatalog.TeamCatalog["Service"], Error, Services>;
    /** Holds the service's next `git fetch` until `release`; `started` completes when it is held. */
    readonly holdNextFetch: Effect.Effect<FetchHold>;
    /** Switches the GitHub CLI login the service sees. */
    readonly signIn: (login: string) => Effect.Effect<void>;
  }) => Effect.Effect<A, E, Services>,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const runner = yield* ProcessRunner.ProcessRunner;
    const temp = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-team-catalog-" });
    const catalog = path.join(temp, "catalog");
    const projectsRoot = path.join(temp, "projects");
    yield* fileSystem.makeDirectory(path.join(catalog, "projects"), { recursive: true });
    yield* fileSystem.makeDirectory(projectsRoot);
    yield* git(catalog, ["init", "--quiet"]);
    const commit = (files: Record<string, unknown>) =>
      Effect.gen(function* () {
        for (const [name, value] of Object.entries(files)) {
          const target = path.join(catalog, "projects", name);
          if (value === null) yield* fileSystem.remove(target);
          else
            yield* fileSystem.writeFileString(
              target,
              typeof value === "string" ? value : JSON.stringify(value),
            );
        }
        yield* git(catalog, ["add", "--all"]);
        yield* git(catalog, ["commit", "--quiet", "--allow-empty", "-m", "catalog"]);
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(ProcessRunner.ProcessRunner, runner),
      );
    const nextFetchHold = yield* Ref.make(Option.none<FetchHold>());
    const holdNextFetch = Effect.gen(function* () {
      const hold = { started: yield* Deferred.make<void>(), release: yield* Deferred.make<void>() };
      yield* Ref.set(nextFetchHold, Option.some(hold));
      return hold;
    });
    const serviceRunner = ProcessRunner.ProcessRunner.of({
      run: (input) =>
        Effect.gen(function* () {
          const hold = input.args.includes("fetch")
            ? yield* Ref.getAndSet(nextFetchHold, Option.none())
            : Option.none<FetchHold>();
          if (Option.isSome(hold)) {
            yield* Deferred.succeed(hold.value.started, undefined);
            yield* Deferred.await(hold.value.release);
          }
          return yield* runner.run(input);
        }),
    });
    const login = yield* Ref.make("alice");
    const configLayer = ServerConfig.layerTest(temp, path.join(temp, "home"));
    const stateDir = yield* ServerConfig.ServerConfig.pipe(
      Effect.map((config) => config.stateDir),
      Effect.provide(configLayer),
    );
    const layer = TeamCatalog.layerWithoutAccess.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(ProcessRunner.ProcessRunner, serviceRunner),
          configLayer,
          accessTest(login),
          RepositoryIdentityResolver.layer,
          ServerSettings.layerTest(),
          Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
            namedProjectsRoot: projectsRoot,
          }),
        ),
      ),
    );
    // Each start is a server start on the same T3 home, alive until the test ends.
    const start = Layer.build(layer).pipe(
      Effect.map((context) => Context.get(context, TeamCatalog.TeamCatalog)),
      Effect.provideService(Scope.Scope, yield* Scope.Scope),
    );
    const service = yield* start;
    return yield* test({
      catalog,
      projectsRoot,
      stateDir,
      commit,
      service,
      start,
      holdNextFetch,
      signIn: (next) => Ref.set(login, next),
    });
  }).pipe(
    Effect.scoped,
    Effect.provide(ProcessRunner.layer.pipe(Layer.provideMerge(NodeServices.layer))),
  );

it.live("reads a catalog, reports bad files, and finds where each project is checked out", () =>
  withCatalog(({ catalog, projectsRoot, commit, service }) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      yield* commit({
        "web.json": project("web", "example.com/acme/web"),
        "api.json": project("api", "example.com/acme/api"),
        "docs.json": project("docs", "example.com/acme/private-docs"),
        "bad.json": { ...project("bad", "example.com/acme/bad"), extra: true },
      });
      yield* fileSystem.makeDirectory(`${projectsRoot}/web`);
      yield* git(`${projectsRoot}/web`, ["init", "--quiet"]);
      yield* git(`${projectsRoot}/web`, [
        "remote",
        "add",
        "origin",
        "https://example.com/acme/web.git",
      ]);
      yield* fileSystem.makeDirectory(`${projectsRoot}/api`);
      yield* fileSystem.writeFileString(`${projectsRoot}/api/notes.txt`, "not a checkout");

      const snapshot = yield* service.setSource(catalog);

      expect(snapshot).toMatchObject({ source: catalog, error: null, refreshing: false });
      expect(snapshot.fetchedAt).not.toBeNull();
      expect(snapshot.invalid.map((entry) => entry.file)).toEqual(["projects/bad.json"]);
      expect(snapshot.viewer).toEqual({ login: "alice", problem: null });
      expect(
        snapshot.projects.map((entry) => [
          entry.project.key,
          entry.checkout.state,
          entry.cloneUrl,
          entry.reachable,
        ]),
      ).toEqual([
        ["api", "occupied", "https://example.com/acme/api.git", true],
        ["docs", "missing", "https://example.com/acme/private-docs.git", false],
        ["web", "present", "https://example.com/acme/web.git", true],
      ]);
      expect(snapshot.projects[1]?.checkout.path).toBe(`${projectsRoot}/private-docs`);
    }),
  ),
);

it.live("fetches again only when forced or stale, and keeps the last good catalog on failure", () =>
  withCatalog(({ catalog, commit, service }) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      yield* commit({ "web.json": project("web", "example.com/acme/web") });
      const first = yield* service.setSource(catalog);
      yield* commit({ "api.json": project("api", "example.com/acme/api"), "web.json": null });

      const recent = yield* service.refresh();
      expect(recent.revision).toBe(first.revision);
      expect(recent.projects.map((entry) => entry.project.key)).toEqual(["web"]);

      const forced = yield* service.refresh({ force: true });
      expect(forced.revision).not.toBe(first.revision);
      expect(forced.projects.map((entry) => entry.project.key)).toEqual(["api"]);

      yield* fileSystem.remove(catalog, { recursive: true });
      const failed = yield* service.refresh({ force: true });
      expect(failed.error).not.toBeNull();
      expect(failed.refreshing).toBe(false);
      expect(failed.revision).toBe(forced.revision);
      expect(failed.projects.map((entry) => entry.project.key)).toEqual(["api"]);
    }),
  ),
);

it.live("reports an unreachable catalog, refuses unsafe URLs, and forgets a cleared one", () =>
  withCatalog(({ catalog, service }) =>
    Effect.gen(function* () {
      const missing = yield* service.setSource(`${catalog}-missing`);
      expect(missing).toMatchObject({
        source: `${catalog}-missing`,
        projects: [],
        fetchedAt: null,
      });
      expect(missing.error).not.toBeNull();

      for (const unsafe of ["--upload-pack=touch /tmp/x", "ext::sh -c touch", "relative/path"]) {
        const refused = yield* Effect.flip(service.setSource(unsafe));
        expect(refused._tag).toBe("TeamCatalogError");
      }
      expect((yield* service.snapshot).source).toBe(`${catalog}-missing`);

      const cleared = yield* service.setSource(null);
      expect(cleared).toMatchObject({ source: null, error: null, projects: [], invalid: [] });
    }),
  ),
);

it.live("serves the last fetch at once after a restart, even with the catalog unreachable", () =>
  withCatalog(({ catalog, commit, service, start }) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      yield* commit({ "web.json": project("web", "example.com/acme/web") });
      const fetched = yield* service.setSource(catalog);
      yield* fileSystem.remove(catalog, { recursive: true });

      const restarted = yield* start;
      const restored = yield* restarted.changes.pipe(
        Stream.filter((snapshot) => snapshot.projects.length > 0),
        Stream.runHead,
      );
      expect(Option.getOrThrow(restored)).toMatchObject({
        source: catalog,
        revision: fetched.revision,
        error: null,
      });
      expect(Option.getOrThrow(restored).fetchedAt).not.toBeNull();

      const failed = yield* restarted.refresh({ force: true });
      expect(failed.error).not.toBeNull();
      expect(failed.fetchedAt).toBe(Option.getOrThrow(restored).fetchedAt);
      expect(failed.projects.map((entry) => entry.project.key)).toEqual(["web"]);
      expect(failed.viewer).toEqual({ login: "alice", problem: null });
    }),
  ),
);

it.effect("counts freshness from when a fetch finishes, not when it starts", () =>
  withCatalog(({ catalog, commit, service, holdNextFetch }) =>
    Effect.gen(function* () {
      yield* commit({ "web.json": project("web", "example.com/acme/web") });
      yield* service.setSource(catalog);

      const hold = yield* holdNextFetch;
      const slowFetch = yield* service.refresh({ force: true }).pipe(Effect.forkChild);
      yield* Deferred.await(hold.started);
      yield* TestClock.adjust("40 seconds");
      yield* Deferred.succeed(hold.release, undefined);
      const fetched = yield* Fiber.join(slowFetch);

      yield* commit({ "api.json": project("api", "example.com/acme/api") });
      const recent = yield* service.refresh();
      expect(recent.revision).toBe(fetched.revision);
      expect(recent.fetchedAt).toBe(fetched.fetchedAt);
      expect(recent.projects.map((entry) => entry.project.key)).toEqual(["web"]);
    }),
  ),
);

it.live(
  "proposes a link change as a branch on the catalog remote, never on the local catalog",
  () =>
    withCatalog(({ catalog, stateDir, commit, service, signIn }) =>
      Effect.gen(function* () {
        const runner = yield* ProcessRunner.ProcessRunner;
        yield* commit({
          "web.json": project("web", "example.com/acme/web", {
            owners: ["Alice"],
            links: [{ project: "api", access: "read" }],
          }),
          "api.json": project("api", "example.com/acme/api", { owners: ["bob"] }),
        });
        const remote = `${catalog}-remote.git`;
        yield* git(catalog, ["clone", "--quiet", "--bare", catalog, remote]);
        const fetched = yield* service.setSource(remote);
        yield* git(`${stateDir}/team-catalog/checkout`, ["config", "commit.gpgSign", "true"]);

        const stale = yield* Effect.flip(
          service.propose({
            baseRevision: "0000000",
            changes: [{ key: "web", parent: null, links: [] }],
          }),
        );
        expect(stale.detail).toContain("changed since you opened it");
        const notOwner = yield* Effect.flip(
          service.propose({
            baseRevision: fetched.revision!,
            changes: [{ key: "api", parent: null, links: [{ project: "web", access: "read" }] }],
          }),
        );
        expect(notOwner.detail).toBe("Only the owners of api can change its parent and links.");
        yield* signIn("bob");
        const switched = yield* Effect.flip(
          service.propose({
            baseRevision: fetched.revision!,
            changes: [{ key: "web", parent: null, links: [] }],
          }),
        );
        expect(switched.detail).toBe("Only the owners of web can change its parent and links.");
        yield* signIn("alice");

        const proposal = yield* service.propose({
          baseRevision: fetched.revision!,
          changes: [
            { key: "web", parent: null, links: [{ project: "api", access: "write" }] },
            { key: "api", parent: null, links: [{ project: "web", access: "write" }] },
          ],
        });
        expect(proposal).toMatchObject({
          remote,
          files: ["projects/web.json", "projects/api.json"],
          pullRequestUrl: null,
          pullRequestProblem: null,
        });
        expect(proposal.branch).toBe(`team-catalog/web-api-links-${proposal.commit.slice(0, 7)}`);

        const show = (...args: ReadonlyArray<string>) =>
          runner
            .run({ command: "git", args: ["-C", remote, "show", ...args] })
            .pipe(Effect.map((output) => output.stdout));
        expect(JSON.parse(yield* show(`${proposal.branch}:projects/api.json`))).toEqual({
          key: "api",
          name: "API",
          repo: "example.com/acme/api",
          owners: ["bob"],
          links: [{ project: "web", access: "write" }],
        });
        expect(yield* show(`${proposal.branch}:projects/web.json`)).toContain('"access": "write"');
        expect(yield* show(`HEAD:projects/web.json`)).toContain('"access":"read"');
        expect(yield* show("-s", "--format=%P", proposal.branch)).toContain(fetched.revision!);
        expect((yield* show("-s", "--format=%an <%ae>|%cn <%ce>", proposal.branch)).trim()).toBe(
          "alice <7+alice@users.noreply.github.com>|alice <7+alice@users.noreply.github.com>",
        );
        const after = yield* service.snapshot;
        expect(after.revision).toBe(fetched.revision);
        expect(after.projects.find((entry) => entry.project.key === "web")?.project.links).toEqual([
          { project: "api", access: "read" },
        ]);
      }),
    ),
);
