import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TeamCatalog from "./TeamCatalog.ts";

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

const project = (key: string, repo: string) => ({ key, name: key.toUpperCase(), repo, owners: [] });

/** A catalog repository, a projects folder, and a service reading them, all in a temp dir. */
const withCatalog = <A, E>(
  test: (fixture: {
    readonly catalog: string;
    readonly projectsRoot: string;
    readonly commit: (files: Record<string, unknown>) => Effect.Effect<void, Error>;
    readonly service: TeamCatalog.TeamCatalog["Service"];
  }) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | ProcessRunner.ProcessRunner>,
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
    const layer = TeamCatalog.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          ServerConfig.layerTest(temp, path.join(temp, "home")),
          RepositoryIdentityResolver.layer,
          ServerSettings.layerTest(),
          Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
            namedProjectsRoot: projectsRoot,
          }),
        ),
      ),
    );
    const service = yield* TeamCatalog.TeamCatalog.pipe(Effect.provide(layer));
    return yield* test({ catalog, projectsRoot, commit, service });
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
        "docs.json": project("docs", "example.com/acme/docs"),
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
      expect(
        snapshot.projects.map((entry) => [entry.project.key, entry.checkout.state, entry.cloneUrl]),
      ).toEqual([
        ["api", "occupied", "https://example.com/acme/api.git"],
        ["docs", "missing", "https://example.com/acme/docs.git"],
        ["web", "present", "https://example.com/acme/web.git"],
      ]);
      expect(snapshot.projects[1]?.checkout.path).toBe(`${projectsRoot}/docs`);
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
