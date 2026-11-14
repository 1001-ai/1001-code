import {
  buildTeamPreferencesBlock,
  type ProjectId,
  type TeamCatalogProposal,
  TeamCatalogError,
  type TeamCatalogSnapshot,
  type TeamPreferencesDocument,
  type TeamPreferencesProposeInput,
  type TeamPreferencesScope,
  type TeamPreferencesView,
  teamCatalogRepositoryMatches,
  teamPreferencesFile,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as TeamCatalog from "../teamCatalog/TeamCatalog.ts";
import { hostedRepositoryOf } from "../teamCatalog/teamCatalogProposal.ts";

/**
 * Team preferences: markdown files in the team catalog repository that every agent turn gets as
 * one `<team_preferences>` block. Changes are proposed to the catalog as pull requests.
 */
export class TeamPreferences extends Context.Service<
  TeamPreferences,
  {
    readonly read: (projectId: ProjectId) => Effect.Effect<TeamPreferencesView>;
    /** The view now, then again whenever the catalog changes. */
    readonly changes: (projectId: ProjectId) => Stream.Stream<TeamPreferencesView>;
    /**
     * The block for a turn in the project, or undefined when there is none. Never fails and never
     * waits for git: a stale catalog is refreshed in the background for later turns.
     */
    readonly instructions: (projectId: ProjectId) => Effect.Effect<string | undefined>;
    readonly propose: (
      input: TeamPreferencesProposeInput,
    ) => Effect.Effect<TeamCatalogProposal, TeamCatalogError>;
  }
>()("t3/teamPreferences/TeamPreferences") {}

const SIGNED_OUT = "Sign in to the GitHub CLI with gh auth login to have personal preferences.";

/** Turns use the cached catalog; one older than this starts a background fetch. */
const STALE_AFTER_MS = 10 * 60_000;

const proposalTitle = (scope: TeamPreferencesScope, label: string | null): string => {
  switch (scope) {
    case "team":
      return "Update team preferences";
    case "project":
      return `Update preferences for ${label ?? "the project"}`;
    case "personal":
      return `Update personal preferences for ${label ?? "me"}`;
  }
};

const make = Effect.gen(function* () {
  const teamCatalog = yield* TeamCatalog.TeamCatalog;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const identities = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
  const backgroundScope = yield* Scope.make();
  yield* Effect.addFinalizer(() => Scope.close(backgroundScope, Exit.void));
  let lastStaleRefreshMs = 0;

  const catalogProject = Effect.fn("TeamPreferences.catalogProject")(function* (
    catalog: TeamCatalogSnapshot,
    projectId: ProjectId,
  ) {
    const project = yield* projects
      .get(projectId)
      .pipe(Effect.orElseSucceed(() => Option.none<ProjectStore.ProjectRow>()));
    if (Option.isNone(project)) return null;
    const identity = yield* identities.resolve(project.value.workspaceRoot);
    return (
      catalog.projects.find((entry) => teamCatalogRepositoryMatches(entry.project.repo, identity))
        ?.project ?? null
    );
  });

  const document = Effect.fn("TeamPreferences.document")(function* (
    scope: TeamPreferencesScope,
    target: { readonly key: string; readonly label: string | null } | string,
  ) {
    if (typeof target === "string") {
      return { scope, file: null, label: null, text: "", unavailable: target };
    }
    const file = teamPreferencesFile(scope, target.key);
    const text = (yield* teamCatalog.readFile(file)) ?? "";
    return { scope, file, label: target.label, text, unavailable: null };
  });

  const read: TeamPreferences["Service"]["read"] = Effect.fn("TeamPreferences.read")(
    function* (projectId) {
      const catalog = yield* teamCatalog.snapshot;
      const base = {
        source: catalog.source,
        revision: catalog.revision,
        refreshing: catalog.refreshing,
        error: catalog.error,
        viewer: catalog.viewer,
      };
      if (catalog.source === null) {
        return { ...base, documents: [], block: null, truncated: false };
      }
      const project = yield* catalogProject(catalog, projectId);
      const login = catalog.viewer.login;
      const documents: ReadonlyArray<TeamPreferencesDocument> = [
        yield* document("team", { key: "team", label: null }),
        yield* document(
          "project",
          project === null
            ? "This project is not in the team catalog."
            : { key: project.key, label: project.name },
        ),
        yield* document(
          "personal",
          login === null ? (catalog.viewer.problem ?? SIGNED_OUT) : { key: login, label: login },
        ),
      ];
      const block = buildTeamPreferencesBlock({
        documents,
        repository: hostedRepositoryOf(catalog.source),
      });
      return {
        ...base,
        documents,
        block: block?.text ?? null,
        truncated: block?.truncated ?? false,
      } satisfies TeamPreferencesView;
    },
  );

  const changes: TeamPreferences["Service"]["changes"] = (projectId) =>
    teamCatalog.changes.pipe(
      Stream.mapEffect(() => read(projectId)),
      Stream.changesWith((a, b) => JSON.stringify(a) === JSON.stringify(b)),
    );

  const refreshWhenStale = Effect.fn("TeamPreferences.refreshWhenStale")(function* (
    catalog: TeamCatalogSnapshot,
  ) {
    if (catalog.source === null || catalog.refreshing) return;
    const now = yield* Clock.currentTimeMillis;
    const fetchedAt = catalog.fetchedAt === null ? 0 : Date.parse(catalog.fetchedAt);
    if (now - fetchedAt < STALE_AFTER_MS || now - lastStaleRefreshMs < STALE_AFTER_MS) return;
    lastStaleRefreshMs = now;
    yield* teamCatalog.refresh().pipe(Effect.forkIn(backgroundScope));
  });

  const instructions: TeamPreferences["Service"]["instructions"] = Effect.fn(
    "TeamPreferences.instructions",
  )(
    function* (projectId) {
      yield* refreshWhenStale(yield* teamCatalog.snapshot);
      return (yield* read(projectId)).block ?? undefined;
    },
    Effect.catchCause((cause) =>
      Effect.logWarning("Team preferences could not be read.", { cause }).pipe(
        Effect.as(undefined),
      ),
    ),
  );

  const propose: TeamPreferences["Service"]["propose"] = Effect.fn("TeamPreferences.propose")(
    function* (input) {
      const view = yield* read(input.projectId);
      const listed = view.documents.find((candidate) => candidate.scope === input.scope);
      // The personal file is the live login's: after a GitHub CLI account switch the cached one
      // would edit the previous person's file under the new author.
      const target =
        input.scope === "personal" && view.source !== null
          ? yield* teamCatalog.liveViewer.pipe(
              Effect.flatMap((viewer) =>
                document(
                  "personal",
                  viewer.login === null
                    ? (viewer.problem ?? SIGNED_OUT)
                    : { key: viewer.login, label: viewer.login },
                ),
              ),
            )
          : listed;
      if (view.source === null || target === undefined) {
        return yield* new TeamCatalogError({ detail: "No team catalog is set." });
      }
      if (target.file === null) {
        return yield* new TeamCatalogError({
          detail: target.unavailable ?? "This scope has no preferences file here.",
        });
      }
      const text = input.text.trim() === "" ? "" : `${input.text.trim()}\n`;
      if (text === target.text) {
        return yield* new TeamCatalogError({
          detail: "Nothing to propose: the file already says this.",
        });
      }
      const name = target.file.slice(target.file.lastIndexOf("/") + 1).replace(/\.md$/, "");
      return yield* teamCatalog.proposeFiles({
        baseRevision: input.baseRevision,
        files: [{ file: target.file, text }],
        title: proposalTitle(input.scope, target.label).slice(0, 200),
        body: [
          `Edits \`${target.file}\`, proposed from the Team preferences panel.`,
          "Agents get the change on their next turn after this is merged.",
        ].join("\n\n"),
        branchStem:
          `team-preferences/${input.scope === "team" ? "team" : `${input.scope}-${name}`}`.slice(
            0,
            80,
          ),
      });
    },
  );

  return TeamPreferences.of({ read, changes, instructions, propose });
});

export const layer = Layer.effect(TeamPreferences, make);
