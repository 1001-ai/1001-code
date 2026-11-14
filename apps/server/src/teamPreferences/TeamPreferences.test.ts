import {
  ProjectId,
  type RepositoryIdentity,
  type TeamCatalogProposal,
  type TeamCatalogSnapshot,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as TeamCatalog from "../teamCatalog/TeamCatalog.ts";
import * as TeamPreferences from "./TeamPreferences.ts";

const PROJECT_ID = ProjectId.make("project-web");

const webIdentity: RepositoryIdentity = {
  canonicalKey: "github.com/acme/web",
  locator: { source: "git-remote", remoteName: "origin", remoteUrl: "git@github.com:acme/web.git" },
};

const catalog = (fields: Partial<TeamCatalogSnapshot> = {}): TeamCatalogSnapshot => ({
  source: "git@github.com:acme/home.git",
  defaultSource: null,
  revision: "rev-1",
  fetchedAt: "1970-01-01T00:00:00.000Z",
  refreshing: false,
  error: null,
  projects: [
    {
      file: "projects/web.json",
      project: { key: "web", name: "Web app", repo: "github.com/acme/web", owners: [] },
      cloneUrl: "git@github.com:acme/web.git",
      checkout: { path: "/projects/web", state: "present" },
      reachable: true,
    },
  ],
  invalid: [],
  viewer: { login: "Alice", problem: null },
  ...fields,
});

const FILES: Record<string, string> = {
  "preferences/team.md": "- Prefer small pull requests.\n",
  "preferences/projects/web.md": "- Run the web tests before pushing.\n",
  "preferences/people/alice.md": "- Keep replies short.\n",
  "preferences/people/bob.md": "- Bob's own rule.\n",
};

const makePreferences = (input: {
  readonly catalog: TeamCatalogSnapshot;
  readonly identity?: RepositoryIdentity | null;
  readonly readFile?: TeamCatalog.TeamCatalog["Service"]["readFile"];
  readonly refreshed?: Deferred.Deferred<void>;
  /** The GitHub CLI's login now, when it differs from the one the snapshot cached. */
  readonly liveLogin?: string | null;
}) => {
  const proposals: Array<TeamCatalog.TeamCatalogFilesProposal> = [];
  const build = TeamPreferences.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(TeamCatalog.TeamCatalog)({
          snapshot: Effect.succeed(input.catalog),
          liveViewer: Effect.succeed(
            input.liveLogin === undefined
              ? input.catalog.viewer
              : {
                  login: input.liveLogin,
                  problem: input.liveLogin === null ? "Signed out." : null,
                },
          ),
          readFile:
            input.readFile ??
            ((file) =>
              Effect.succeed(input.catalog.source === null ? null : (FILES[file] ?? null))),
          refresh: () =>
            (input.refreshed === undefined
              ? Effect.void
              : Deferred.succeed(input.refreshed, undefined)
            ).pipe(Effect.as(input.catalog)),
          proposeFiles: (proposal) =>
            Effect.sync(() => {
              proposals.push(proposal);
              return {
                branch: `${proposal.branchStem}-abc1234`,
                commit: "abc1234",
                remote: "git@github.com:acme/home.git",
                files: proposal.files.map((edit) => edit.file),
                pullRequestUrl: "https://github.com/acme/home/pull/1",
                pullRequestProblem: null,
              } satisfies TeamCatalogProposal;
            }),
        }),
        Layer.mock(ProjectStore.ProjectStoreV2)({
          get: () =>
            Effect.succeedSome({
              projectId: PROJECT_ID,
              workspaceRoot: "/projects/web",
            } as unknown as ProjectStore.ProjectRow),
        }),
        Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({
          resolve: () =>
            Effect.succeed(input.identity === undefined ? webIdentity : input.identity),
        }),
      ),
    ),
    Layer.build,
    Effect.map((context) => Context.get(context, TeamPreferences.TeamPreferences)),
  );
  return { build, proposals };
};

it.effect(
  "reads the team file, the project's file by its remote, and only the viewer's own file",
  () =>
    Effect.gen(function* () {
      const preferences = yield* makePreferences({ catalog: catalog() }).build;
      const view = yield* preferences.read(PROJECT_ID);
      expect(view.documents).toEqual([
        {
          scope: "team",
          file: "preferences/team.md",
          label: null,
          text: FILES["preferences/team.md"],
          unavailable: null,
        },
        {
          scope: "project",
          file: "preferences/projects/web.md",
          label: "Web app",
          text: FILES["preferences/projects/web.md"],
          unavailable: null,
        },
        {
          scope: "personal",
          file: "preferences/people/alice.md",
          label: "Alice",
          text: FILES["preferences/people/alice.md"],
          unavailable: null,
        },
      ]);
      const block = yield* preferences.instructions(PROJECT_ID);
      expect(block).toBe(view.block);
      expect(block).toContain("in github.com/acme/home");
      const team = block!.indexOf("Prefer small pull requests");
      const project = block!.indexOf("Run the web tests");
      const personal = block!.indexOf("Keep replies short");
      expect(team).toBeGreaterThan(0);
      expect(project).toBeGreaterThan(team);
      expect(personal).toBeGreaterThan(project);
      expect(block).not.toContain("Bob's own rule");
    }).pipe(Effect.scoped),
);

it.effect("says why a scope has no file, and sends nothing without a catalog", () =>
  Effect.gen(function* () {
    const signedOut = yield* makePreferences({
      catalog: catalog({ viewer: { login: null, problem: "The GitHub CLI is not signed in." } }),
      identity: null,
    }).build;
    const view = yield* signedOut.read(PROJECT_ID);
    expect(view.documents.map((document) => [document.file, document.unavailable])).toEqual([
      ["preferences/team.md", null],
      [null, "This project is not in the team catalog."],
      [null, "The GitHub CLI is not signed in."],
    ]);
    expect(view.block).toContain("Prefer small pull requests");
    expect(view.block).not.toContain("Keep replies short");

    const none = yield* makePreferences({ catalog: catalog({ source: null }) }).build;
    expect(yield* none.read(PROJECT_ID)).toMatchObject({ documents: [], block: null });
    expect(yield* none.instructions(PROJECT_ID)).toBeUndefined();
  }).pipe(Effect.scoped),
);

it.effect("proposes the edited file, and refuses an unchanged one or a scope without a file", () =>
  Effect.gen(function* () {
    const fixture = makePreferences({ catalog: catalog(), identity: null });
    const preferences = yield* fixture.build;
    const propose = (scope: "team" | "project" | "personal", text: string) =>
      preferences.propose({ projectId: PROJECT_ID, scope, baseRevision: "rev-1", text });

    expect((yield* Effect.flip(propose("project", "- Anything."))).detail).toBe(
      "This project is not in the team catalog.",
    );
    expect((yield* Effect.flip(propose("team", "  - Prefer small pull requests.  "))).detail).toBe(
      "Nothing to propose: the file already says this.",
    );
    const proposal = yield* propose("personal", "- Keep replies short.\n- Say what changed.\n\n");
    expect(proposal.pullRequestUrl).toBe("https://github.com/acme/home/pull/1");
    expect(fixture.proposals).toEqual([
      {
        baseRevision: "rev-1",
        files: [
          {
            file: "preferences/people/alice.md",
            text: "- Keep replies short.\n- Say what changed.\n",
          },
        ],
        title: "Update personal preferences for Alice",
        body: expect.stringContaining("preferences/people/alice.md"),
        branchStem: "team-preferences/personal-alice",
      },
    ]);

    // After a GitHub CLI account switch, a personal edit goes to the signed-in person's file.
    const switched = makePreferences({ catalog: catalog(), liveLogin: "Bob" });
    const bob = yield* switched.build;
    yield* bob.propose({
      projectId: PROJECT_ID,
      scope: "personal",
      baseRevision: "rev-1",
      text: "- Bob's new rule.",
    });
    expect(switched.proposals.map((proposal) => proposal.files)).toEqual([
      [{ file: "preferences/people/bob.md", text: "- Bob's new rule.\n" }],
    ]);
    const signedOut = yield* makePreferences({ catalog: catalog(), liveLogin: null }).build;
    const refused = yield* Effect.flip(
      signedOut.propose({
        projectId: PROJECT_ID,
        scope: "personal",
        baseRevision: "rev-1",
        text: "- Anything.",
      }),
    );
    expect(refused.detail).toBe("Signed out.");
  }).pipe(Effect.scoped),
);

it.effect("refreshes a stale catalog in the background, and a failed read sends nothing", () =>
  Effect.gen(function* () {
    const refreshed = yield* Deferred.make<void>();
    const preferences = yield* makePreferences({ catalog: catalog(), refreshed }).build;
    yield* TestClock.adjust("11 minutes");
    expect(yield* preferences.instructions(PROJECT_ID)).toContain("Prefer small pull requests");
    yield* Deferred.await(refreshed);

    const broken = yield* makePreferences({
      catalog: catalog(),
      readFile: () => Effect.die("disk gone"),
    }).build;
    expect(yield* broken.instructions(PROJECT_ID)).toBeUndefined();
  }).pipe(Effect.scoped),
);
