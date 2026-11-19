import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AGENTS_BOARD_MEDIA_MAX_BYTES,
  type AgentsBoardSnapshot,
  ProjectId,
  type RepositoryIdentity,
  type TeamCatalogSnapshot,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { ChildProcessSpawner } from "effect/process";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as TeamCatalog from "../teamCatalog/TeamCatalog.ts";
import * as AgentsBoard from "./AgentsBoard.ts";
import { AGENTS_BOARD_LIMITS } from "./agentsBoardFiles.ts";

const PROJECT_ID = ProjectId.make("project-web");
const BRANCH = "agent-reports";
const NOTES_REPOSITORY = "example.com/acme/web-notes";
/** What the catalog's own source, over HTTPS on the same host, makes of that repository. */
const NOTES_URL = "https://example.com/acme/web-notes.git";

const GIT_IDENTITY = {
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.test",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.test",
};

const webIdentity: RepositoryIdentity = {
  canonicalKey: "example.com/acme/web",
  locator: {
    source: "git-remote",
    remoteName: "origin",
    remoteUrl: "https://example.com/acme/web.git",
  },
};

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe, 0x80]);

const REPORT = [
  "# sam-2",
  "",
  "- owner: Sam",
  "- tool: Cursor cloud agent",
  "",
  "## 2026-11-16T00:12:45Z · working",
  "",
  "Measuring the sign-in page — it takes 2 s.",
  "",
  "- needs: nothing",
  "- media: media/sam-2/shot.png",
  "",
].join("\n");

type Services =
  | FileSystem.FileSystem
  | Path.Path
  | ProcessRunner.ProcessRunner
  | ChildProcessSpawner.ChildProcessSpawner;

/** A project repository in a temp dir, the catalog that lists it, and a service reading both. */
const withBoard = <A, E>(
  test: (fixture: {
    readonly remote: string;
    /** A second repository, which the service reaches as `NOTES_URL`. */
    readonly notes: string;
    readonly stateDir: string;
    /** Commits files to a branch of a repository, the project's unless named; a Buffer is bytes. */
    readonly commit: (
      branch: string,
      files: Record<string, string | Buffer>,
      repository?: string,
    ) => Effect.Effect<void, Error>;
    readonly service: AgentsBoard.AgentsBoard["Service"];
    /** Starts another server on the same state directory. */
    readonly start: Effect.Effect<AgentsBoard.AgentsBoard["Service"], Error, Services>;
    readonly catalog: SubscriptionRef.SubscriptionRef<TeamCatalogSnapshot>;
    /** How many times the service has run `git fetch`. */
    readonly fetches: () => number;
    /** The arguments of every `git push` the service ran. */
    readonly pushes: () => ReadonlyArray<ReadonlyArray<string>>;
    /** Runs once, just before the service's next push reaches the repository. */
    readonly beforeNextPush: (race: Effect.Effect<void, Error>) => void;
    /** What the GitHub CLI answers for the signed-in person; null signs it out. */
    readonly signIn: (profile: string | null) => void;
  }) => Effect.Effect<A, E, Services>,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const runner = yield* ProcessRunner.ProcessRunner;
    const temp = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-agents-board-" });
    const remote = path.join(temp, "web");
    const notes = path.join(temp, "web-notes");
    const git = (repository: string, args: ReadonlyArray<string>) =>
      runner
        .run({
          command: "git",
          args: ["-C", repository, ...args],
          env: { ...process.env, ...GIT_IDENTITY },
        })
        .pipe(
          Effect.tap((output) => Effect.sync(() => expect(output.code, output.stderr).toBe(0))),
        );
    for (const repository of [remote, notes]) {
      yield* fileSystem.makeDirectory(repository);
      yield* git(repository, ["init", "--quiet", "--initial-branch=main"]);
      yield* git(repository, ["commit", "--quiet", "--allow-empty", "-m", "first commit"]);
    }
    const commit = (branch: string, files: Record<string, string | Buffer>, repository = remote) =>
      Effect.gen(function* () {
        const exists = yield* runner.run({
          command: "git",
          args: ["-C", repository, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`],
        });
        yield* git(
          repository,
          exists.code === 0
            ? ["checkout", "--quiet", branch]
            : ["checkout", "--quiet", "--orphan", branch],
        );
        for (const [name, value] of Object.entries(files)) {
          const target = path.join(repository, name);
          yield* fileSystem.makeDirectory(path.dirname(target), { recursive: true });
          yield* typeof value === "string"
            ? fileSystem.writeFileString(target, value)
            : fileSystem.writeFile(target, value);
        }
        yield* git(repository, ["add", "--all"]);
        yield* git(repository, ["commit", "--quiet", "--allow-empty", "-m", "report"]);
        yield* git(repository, ["checkout", "--quiet", "main"]);
      });

    const catalog = yield* SubscriptionRef.make<TeamCatalogSnapshot>({
      source: "https://example.com/acme/home.git",
      defaultSource: null,
      revision: "rev-1",
      fetchedAt: "1970-01-01T00:00:00.000Z",
      refreshing: false,
      error: null,
      projects: [
        {
          file: "projects/web.json",
          project: { key: "web", name: "Web app", repo: "example.com/acme/web", owners: [] },
          // The service fetches from the catalog's clone URL; here that is the temp repository.
          cloneUrl: remote,
          checkout: { path: "/projects/web", state: "present" },
          reachable: true,
        },
      ],
      invalid: [],
      viewer: { login: null, problem: null },
    });
    let fetches = 0;
    const pushes: Array<ReadonlyArray<string>> = [];
    let race: Effect.Effect<void, Error> | null = null;
    let profile: string | null = "sam\t42\tSam Example";
    const answer = (code: number, stdout: string) => ({
      stdout,
      stderr: "",
      code: code as never,
      timedOut: false,
      stdoutTruncated: false,
      stderrTruncated: false,
      stdoutInvalidUtf8: false,
      stderrInvalidUtf8: false,
    });
    // No test reaches the network: the other repository's URL is the temp repository.
    const reach = (input: Parameters<ProcessRunner.ProcessRunner["Service"]["run"]>[0]) =>
      runner.run({ ...input, args: input.args.map((arg) => (arg === NOTES_URL ? notes : arg)) });
    const countingRunner = ProcessRunner.ProcessRunner.of({
      run: (input) => {
        // No test reaches GitHub: the CLI's answer is the fixture's.
        if (input.command === "gh") {
          return Effect.succeed(profile === null ? answer(1, "") : answer(0, `${profile}\n`));
        }
        if (input.args.includes("fetch")) fetches += 1;
        if (!input.args.includes("push")) return reach(input);
        pushes.push(input.args);
        const racing = race;
        race = null;
        return (racing ?? Effect.void).pipe(Effect.orDie, Effect.andThen(reach(input)));
      },
    });
    const configLayer = ServerConfig.layerTest(temp, path.join(temp, "home"));
    const stateDir = yield* ServerConfig.ServerConfig.pipe(
      Effect.map((config) => config.stateDir),
      Effect.provide(configLayer),
    );
    const layer = AgentsBoard.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(ProcessRunner.ProcessRunner, countingRunner),
          configLayer,
          Digest.layerWebCrypto,
          Layer.mock(TeamCatalog.TeamCatalog)({
            snapshot: SubscriptionRef.get(catalog),
            changes: SubscriptionRef.changes(catalog),
          }),
          Layer.mock(ProjectStore.ProjectStoreV2)({
            get: () =>
              Effect.succeedSome({
                projectId: PROJECT_ID,
                workspaceRoot: "/projects/web",
              } as unknown as ProjectStore.ProjectRow),
          }),
          Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({
            resolve: () => Effect.succeed(webIdentity),
          }),
        ),
      ),
    );
    const scope = yield* Scope.Scope;
    const start = Layer.build(layer).pipe(
      Effect.map((context) => Context.get(context, AgentsBoard.AgentsBoard)),
      Effect.provideService(Scope.Scope, scope),
    );
    return yield* test({
      remote,
      notes,
      stateDir,
      commit,
      service: yield* start,
      start,
      catalog,
      fetches: () => fetches,
      pushes: () => pushes,
      beforeNextPush: (next) => {
        race = next;
      },
      signIn: (next) => {
        profile = next;
      },
    });
  }).pipe(
    Effect.scoped,
    Effect.provide(ProcessRunner.layer.pipe(Layer.provideMerge(NodeServices.layer))),
  );

const settled = (snapshot: AgentsBoardSnapshot) =>
  snapshot.status !== "unavailable" && snapshot.status !== "loading" && !snapshot.refreshing;

const untilSettled = (service: AgentsBoard.AgentsBoard["Service"]) =>
  service.changes(PROJECT_ID).pipe(
    Stream.takeUntil(settled),
    Stream.runCollect,
    Effect.map((snapshots) => Array.from(snapshots)),
  );

it.live("reads a repository with no agents branch as that, and the branch once it exists", () =>
  withBoard(({ commit, service, stateDir }) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      const opened = yield* untilSettled(service);
      expect(opened[0]).toMatchObject({ status: "loading", branch: BRANCH });
      expect(opened.at(-1)).toEqual({
        status: "missing-branch",
        project: { key: "web", name: "Web app" },
        branch: BRANCH,
        refreshing: false,
      });

      yield* commit(BRANCH, {
        "README.md": "Instructions for agents.\n",
        "reports/sam-2.md": REPORT,
        "inbox/all.md": "## 2026-11-16T00:37:00Z · from Robin\n\nStand-up at ten.\n",
        "media/sam-2/shot.png": PNG,
      });
      const board = yield* service.refresh(PROJECT_ID);
      expect(board).toMatchObject({
        status: "ready",
        branch: BRANCH,
        refreshing: false,
        failure: null,
        board: {
          agents: [{ id: "sam-2", owner: "Sam", latestStatus: "working", needs: null }],
          activeCount: 1,
          needsPersonCount: 0,
          truncated: false,
        },
      });
      if (board.status !== "ready") return;
      expect(board.board.messages).toMatchObject([
        {
          _tag: "agent",
          agentId: "sam-2",
          text: "Measuring the sign-in page — it takes 2 s.",
          media: ["media/sam-2/shot.png"],
        },
        { _tag: "person", from: "Robin", to: null, text: "Stand-up at ten." },
      ]);

      // The cache is a bare repository in the state directory: nothing is checked out.
      const repos = path.join(stateDir, "agents-board", "repos");
      const [cache] = yield* fileSystem.readDirectory(repos);
      expect(cache).toMatch(/^[0-9a-f]{32}\.git$/);
      const cached = yield* fileSystem.readDirectory(path.join(repos, cache!));
      expect(cached).toContain("HEAD");
      expect(cached).not.toContain("reports");
      expect(cached).not.toContain("README.md");
    }),
  ),
);

it.live("serves the last fetch after a restart and while the repository is out of reach", () =>
  withBoard(({ commit, service, start, remote }) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      yield* commit(BRANCH, { "reports/sam-2.md": REPORT });
      expect(yield* service.refresh(PROJECT_ID)).toMatchObject({ status: "ready" });

      yield* fileSystem.rename(remote, `${remote}-moved`);
      const restarted = yield* start;
      // Reading never reaches the network.
      expect(yield* restarted.read(PROJECT_ID)).toMatchObject({
        status: "ready",
        failure: null,
        board: { agents: [{ id: "sam-2" }] },
      });
      const failed = yield* restarted.refresh(PROJECT_ID);
      expect(failed).toMatchObject({
        status: "ready",
        refreshing: false,
        board: { agents: [{ id: "sam-2" }] },
      });
      expect(failed.status === "ready" ? failed.failure : null).toEqual(expect.any(String));

      const fresh = yield* start;
      yield* fileSystem.rename(`${remote}-moved`, remote);
      expect(yield* fresh.refresh(PROJECT_ID)).toMatchObject({ status: "ready", failure: null });
    }),
  ),
);

it.live("leaves out oversized files and links, and says the board is incomplete", () =>
  withBoard(({ commit, service, remote }) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* commit(BRANCH, {
        "reports/sam-2.md": REPORT,
        "reports/big-1.md": `## 2026-11-16T00:00:00Z · working\n${"x".repeat(AGENTS_BOARD_LIMITS.maxFileBytes)}\n`,
        "reports/notes.txt": "## 2026-11-16T00:00:00Z · working\nNot a report.\n",
        "reports/deep/kim-1.md": "## 2026-11-16T00:00:00Z · working\nNot a report.\n",
      });
      // A link named like a report must not make the server read a file outside the branch.
      yield* fileSystem.symlink("/etc/hosts", path.join(remote, "link-9.md"));
      yield* commit(BRANCH, {});
      yield* Effect.gen(function* () {
        const runner = yield* ProcessRunner.ProcessRunner;
        const run = (args: ReadonlyArray<string>) =>
          runner.run({
            command: "git",
            args: ["-C", remote, ...args],
            env: { ...process.env, ...GIT_IDENTITY },
          });
        yield* run(["checkout", "--quiet", BRANCH]);
        yield* run(["mv", "link-9.md", "reports/link-9.md"]);
        yield* run(["commit", "--quiet", "-m", "link"]);
        yield* run(["checkout", "--quiet", "main"]);
      });

      const board = yield* service.refresh(PROJECT_ID);
      expect(board).toMatchObject({
        status: "ready",
        board: { agents: [{ id: "sam-2" }], truncated: true },
      });
      expect(board.status === "ready" ? board.board.messages : []).toHaveLength(1);
    }),
  ),
);

it.live("serves only real images under media/, up to 500 KB", () =>
  withBoard(({ commit, service, remote }) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const media = (file: string) =>
        service.media({ projectId: PROJECT_ID, path: file }).pipe(
          Effect.map((image) => ({ mimeType: image.mimeType, base64: image.base64 })),
          Effect.catch((error) => Effect.succeed(error.reason)),
        );

      expect(yield* media("media/sam-2/shot.png")).toBe("not-fetched");

      const big = Buffer.concat([PNG, Buffer.alloc(AGENTS_BOARD_MEDIA_MAX_BYTES)]);
      yield* commit(BRANCH, {
        "reports/sam-2.md": REPORT,
        "media/sam-2/shot.png": PNG,
        // A JPEG named .png is served as what it is.
        "media/sam-2/photo.png": Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]),
        "media/sam-2/page.png": "<!doctype html><script>alert(1)</script>",
        "media/sam-2/big.png": big,
        "secret.png": PNG,
      });
      yield* fileSystem.makeDirectory(path.join(remote, "outside"));
      yield* service.refresh(PROJECT_ID);

      expect(yield* media("media/sam-2/shot.png")).toEqual({
        mimeType: "image/png",
        base64: PNG.toString("base64"),
      });
      expect(yield* media("media/sam-2/photo.png")).toMatchObject({ mimeType: "image/jpeg" });
      expect(yield* media("media/sam-2/page.png")).toBe("not-an-image");
      expect(yield* media("media/sam-2/big.png")).toBe("too-large");
      expect(yield* media("media/sam-2/none.png")).toBe("not-found");
      // The service checks the path itself, for callers that do not come through the RPC schema.
      for (const escaped of [
        "secret.png",
        "media/../secret.png",
        "media/sam-2/../../secret.png",
        "reports/sam-2.md",
        "/etc/hosts",
        "media/sam-2",
        ":(glob)media/**/*.png",
      ]) {
        expect(yield* media(escaped), escaped).toBe("not-found");
      }
    }),
  ),
);

it.live("keeps the branch name per repository, and goes back to the default", () =>
  withBoard(({ commit, service, start, catalog }) =>
    Effect.gen(function* () {
      yield* commit("team/agent-notes", { "reports/kim-1.md": "- owner: Kim\n" });

      const renamed = yield* service.setBranch({
        projectId: PROJECT_ID,
        branch: "team/agent-notes",
      });
      expect(renamed).toMatchObject({
        status: "ready",
        branch: "team/agent-notes",
        board: { agents: [{ id: "kim-1" }] },
      });
      // Another server start on the same state directory reads the same branch.
      expect(yield* (yield* start).read(PROJECT_ID)).toMatchObject({
        status: "ready",
        branch: "team/agent-notes",
      });

      expect(yield* service.setBranch({ projectId: PROJECT_ID, branch: null })).toMatchObject({
        status: "missing-branch",
        branch: BRANCH,
      });

      yield* SubscriptionRef.update(catalog, (current) => ({ ...current, projects: [] }));
      expect(yield* service.read(PROJECT_ID)).toEqual({
        status: "unavailable",
        reason: "not-in-catalog",
      });
      expect(
        yield* service
          .setBranch({ projectId: PROJECT_ID, branch: "agent-notes" })
          .pipe(Effect.flip),
      ).toMatchObject({ reason: "not-a-team-project" });
      yield* SubscriptionRef.update(catalog, (current) => ({ ...current, source: null }));
      expect(yield* service.read(PROJECT_ID)).toEqual({
        status: "unavailable",
        reason: "no-catalog",
      });
    }),
  ),
);

it.effect(
  "fetches when a board opens, not again for 30 seconds, and never for a catalog change",
  () =>
    withBoard(({ commit, service, catalog, fetches }) =>
      Effect.gen(function* () {
        yield* commit(BRANCH, { "reports/sam-2.md": REPORT });
        expect((yield* untilSettled(service)).at(-1)).toMatchObject({ status: "ready" });
        expect(fetches()).toBe(1);

        // A second board opened right away shows the same fetch.
        yield* TestClock.adjust("20 seconds");
        const again = yield* service.changes(PROJECT_ID).pipe(Stream.take(1), Stream.runCollect);
        expect(Array.from(again)).toMatchObject([{ status: "ready", refreshing: false }]);
        expect(yield* service.read(PROJECT_ID)).toMatchObject({ refreshing: false });

        // A catalog change re-reads which project this is, and fetches nothing however old.
        yield* TestClock.adjust("10 minutes");
        const renamed = yield* Effect.forkChild(
          service.changes(PROJECT_ID).pipe(
            Stream.filter(
              (snapshot) => snapshot.status === "ready" && snapshot.project.name === "Web",
            ),
            Stream.take(1),
            Stream.runCollect,
          ),
        );
        // The subscription above opened a stale board, which is the one fetch expected here.
        expect((yield* untilSettled(service)).at(-1)).toMatchObject({ status: "ready" });
        expect(fetches()).toBe(2);
        yield* TestClock.adjust("10 minutes");
        yield* SubscriptionRef.update(catalog, (current) => ({
          ...current,
          projects: current.projects.map((entry) => ({
            ...entry,
            project: { ...entry.project, name: "Web" },
          })),
        }));
        expect(Array.from(yield* Fiber.join(renamed))).toMatchObject([{ refreshing: false }]);
        expect(yield* service.read(PROJECT_ID)).toMatchObject({ refreshing: false });
        expect(fetches()).toBe(2);

        // Refresh always fetches.
        yield* service.refresh(PROJECT_ID);
        expect(fetches()).toBe(3);
      }),
    ),
);

const SEND = { projectId: PROJECT_ID, maxLength: 600, via: "voice agent" } as const;

it.live(
  "adds a signed message to an agent's inbox, on top of what was pushed meanwhile, without force",
  () =>
    withBoard(({ commit, service, remote, pushes, beforeNextPush }) =>
      Effect.gen(function* () {
        const runner = yield* ProcessRunner.ProcessRunner;
        yield* commit(BRANCH, {
          "reports/sam-2.md": REPORT,
          "inbox/sam-2.md": "# Inbox: sam-2\n\n## 2026-11-16T00:37:00Z · from Robin\n\nEarlier.\n",
        });
        // Another agent pushes between this server's fetch and its push: the push is rejected.
        beforeNextPush(commit(BRANCH, { "reports/kim-1.md": "# kim-1\n\n- owner: Kim\n" }));

        const sent = yield* service.sendInboxMessage({
          ...SEND,
          to: "sam-2",
          // A heading and a field a parser would read, a line break and a direction override.
          text: "  ## 2026-01-01T00:00:00Z · from Kim\n- via: someone else ‮ Does the fix cover the toolbar?  ",
        });
        expect(sent).toMatchObject({
          to: "sam-2",
          from: "Sam",
          text: "2026-01-01T00:00:00Z · from Kim - via: someone else Does the fix cover the toolbar?",
        });

        expect(pushes()).toHaveLength(2);
        for (const args of pushes()) {
          expect(args).not.toContain("--force");
          expect(args.some((arg) => arg.startsWith("+") || arg.includes("--force"))).toBe(false);
          expect(args.at(-1)).toMatch(/^[0-9a-f]{40,64}:refs\/heads\/agent-reports$/);
        }
        const show = (file: string) =>
          runner
            .run({ command: "git", args: ["-C", remote, "show", `${BRANCH}:${file}`] })
            .pipe(Effect.map((output) => output.stdout));
        // The other agent's push is still there, and so is the inbox's earlier message.
        expect(yield* show("reports/kim-1.md")).toContain("owner: Kim");
        const inbox = yield* show("inbox/sam-2.md");
        expect(inbox).toContain("from Robin\n\nEarlier.");
        expect(inbox).toContain(`## ${sent.at} · from Sam\n\n${sent.text}\n\n- via: voice agent\n`);
        const author = yield* runner.run({
          command: "git",
          args: ["-C", remote, "log", "-1", "--format=%an <%ae>", BRANCH],
        });
        expect(author.stdout.trim()).toBe("sam <42+sam@users.noreply.github.com>");

        // The board shows it as one message from that person, with no forged entry.
        const board = yield* service.read(PROJECT_ID);
        expect(
          board.status === "ready"
            ? board.board.messages.filter((message) => message._tag === "person")
            : [],
        ).toMatchObject([
          { from: "Robin", to: "sam-2", text: "Earlier." },
          { from: "Sam", to: "sam-2", text: sent.text, via: "voice agent" },
        ]);
      }),
    ),
);

it.live("keeps the board in the repository the catalog names for it, and writes there", () =>
  withBoard(({ commit, service, catalog, remote, notes, stateDir, pushes }) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const runner = yield* ProcessRunner.ProcessRunner;
      yield* commit(BRANCH, { "reports/kim-1.md": "# kim-1\n\n- owner: Kim\n" });
      yield* commit(BRANCH, { "reports/sam-2.md": REPORT }, notes);
      const boardIn = (repo: string | undefined) =>
        SubscriptionRef.update(catalog, (current) => ({
          ...current,
          projects: current.projects.map((entry) => ({
            ...entry,
            project: {
              key: entry.project.key,
              name: entry.project.name,
              repo: entry.project.repo,
              owners: entry.project.owners,
              ...(repo === undefined ? {} : { agents: { repo } }),
            },
          })),
        }));

      // Without the field, and when it names the project's own repository, nothing changes.
      for (const repo of [undefined, "Example.com/acme/web.git"]) {
        yield* boardIn(repo);
        const own = yield* service.refresh(PROJECT_ID);
        expect(own).toMatchObject({ status: "ready", board: { agents: [{ id: "kim-1" }] } });
        expect(own).not.toHaveProperty("repository");
      }

      yield* boardIn(NOTES_REPOSITORY);
      expect(yield* service.read(PROJECT_ID)).toMatchObject({
        status: "loading",
        repository: NOTES_REPOSITORY,
      });
      expect(yield* service.refresh(PROJECT_ID)).toMatchObject({
        status: "ready",
        project: { key: "web", name: "Web app" },
        repository: NOTES_REPOSITORY,
        board: { agents: [{ id: "sam-2" }] },
      });
      // Each repository has its own cache, and the branch name is kept for the board's.
      const state = path.join(stateDir, "agents-board");
      expect(yield* fileSystem.readDirectory(path.join(state, "repos"))).toHaveLength(2);
      yield* service.setBranch({ projectId: PROJECT_ID, branch: "team/agent-notes" });
      expect(
        JSON.parse(yield* fileSystem.readFileString(path.join(state, "settings.json"))),
      ).toEqual({ branches: { [NOTES_REPOSITORY]: "team/agent-notes" } });
      yield* service.setBranch({ projectId: PROJECT_ID, branch: null });

      yield* service.sendInboxMessage({ ...SEND, to: "sam-2", text: "Does it cover the toolbar?" });
      expect(pushes().map((args) => args.at(-2))).toEqual([NOTES_URL]);
      const inbox = (repository: string) =>
        runner
          .run({ command: "git", args: ["-C", repository, "show", `${BRANCH}:inbox/sam-2.md`] })
          .pipe(Effect.map((output) => output.code));
      expect(yield* inbox(notes)).toBe(0);
      expect(yield* inbox(remote)).not.toBe(0);
    }),
  ),
);

it.live("refuses a message it cannot sign, address or keep short, and pushes nothing", () =>
  withBoard(({ commit, service, pushes, signIn }) =>
    Effect.gen(function* () {
      yield* commit(BRANCH, { "reports/sam-2.md": REPORT });
      const refused = (input: { readonly to: string; readonly text: string }) =>
        service.sendInboxMessage({ ...SEND, ...input }).pipe(
          Effect.flip,
          Effect.map((error) => error.reason),
        );
      expect(yield* refused({ to: "sam-2", text: " \n\u0007 " })).toBe("empty-message");
      expect(yield* refused({ to: "sam-2", text: "x".repeat(601) })).toBe("message-too-long");
      // An agent with no report on the branch gets no inbox file, whatever its name.
      expect(yield* refused({ to: "kim-9", text: "Hello." })).toBe("unknown-agent");
      expect(yield* refused({ to: "../reports/sam-2", text: "Hello." })).toBe("unknown-agent");
      expect(yield* refused({ to: "README", text: "Hello." })).toBe("unknown-agent");
      signIn(null);
      expect(yield* refused({ to: "sam-2", text: "Hello." })).toBe("not-signed-in");
      expect(pushes()).toEqual([]);

      // A profile without a name signs with the login; every agent's inbox is `all`.
      signIn("sam\t42\t");
      expect(
        yield* service.sendInboxMessage({ ...SEND, to: "all", text: "Stand-up at ten." }),
      ).toMatchObject({ to: null, from: "sam" });
      expect(pushes()).toHaveLength(1);
    }),
  ),
);
