import {
  buildPreferencesBlock,
  type ProjectId,
  type TeamCatalogProposal,
  TeamCatalogError,
  type TeamCatalogSnapshot,
  type PreferencesDocument,
  type PreferencesProposeInput,
  type PreferencesScope,
  type PreferencesView,
  teamCatalogRepositoryMatches,
  preferencesFile,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
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
 * Preferences: markdown files in the team catalog repository that every agent turn gets as
 * one `<preferences>` block. Changes are proposed to the catalog as pull requests.
 */
export class Preferences extends Context.Service<
  Preferences,
  {
    readonly read: (projectId: ProjectId) => Effect.Effect<PreferencesView>;
    /** The view now, then again whenever the catalog changes. */
    readonly changes: (projectId: ProjectId) => Stream.Stream<PreferencesView>;
    /**
     * The block for a turn in the project, or undefined when there is none. Never fails and never
     * waits for git: a stale catalog is refreshed in the background for later turns.
     */
    readonly instructions: (projectId: ProjectId) => Effect.Effect<string | undefined>;
    readonly propose: (
      input: PreferencesProposeInput,
    ) => Effect.Effect<TeamCatalogProposal, TeamCatalogError>;
  }
>()("t3/preferences/Preferences") {}

const SIGNED_OUT = "Sign in to the GitHub CLI with gh auth login to have personal preferences.";

/** Turns use the cached catalog; one older than this starts a background fetch. */
const STALE_AFTER_MS = 10 * 60_000;

const proposalTitle = (scope: PreferencesScope, label: string | null): string => {
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

  const catalogProject = Effect.fn("Preferences.catalogProject")(function* (
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

  const document = Effect.fn("Preferences.document")(function* (
    scope: PreferencesScope,
    target: { readonly key: string; readonly label: string | null } | string,
  ) {
    if (typeof target === "string") {
      return { scope, file: null, label: null, text: "", unavailable: target };
    }
    const file = preferencesFile(scope, target.key);
    const text = (yield* teamCatalog.readFile(file)) ?? "";
    return { scope, file, label: target.label, text, unavailable: null };
  });

  const read: Preferences["Service"]["read"] = Effect.fn("Preferences.read")(function* (projectId) {
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
    const documents: ReadonlyArray<PreferencesDocument> = [
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
    const block = buildPreferencesBlock({
      documents,
      repository: hostedRepositoryOf(catalog.source),
    });
    return {
      ...base,
      documents,
      block: block?.text ?? null,
      truncated: block?.truncated ?? false,
    } satisfies PreferencesView;
  });

  const changes: Preferences["Service"]["changes"] = (projectId) =>
    teamCatalog.changes.pipe(
      Stream.mapEffect(() => read(projectId)),
      Stream.changesWith((a, b) => JSON.stringify(a) === JSON.stringify(b)),
    );

  const refreshWhenStale = Effect.fn("Preferences.refreshWhenStale")(function* (
    catalog: TeamCatalogSnapshot,
  ) {
    if (catalog.source === null || catalog.refreshing) return;
    const now = yield* Clock.currentTimeMillis;
    const fetchedAt = catalog.fetchedAt === null ? 0 : Date.parse(catalog.fetchedAt);
    if (now - fetchedAt < STALE_AFTER_MS || now - lastStaleRefreshMs < STALE_AFTER_MS) return;
    lastStaleRefreshMs = now;
    yield* teamCatalog.refresh().pipe(Effect.forkIn(backgroundScope));
  });

  const instructions: Preferences["Service"]["instructions"] = Effect.fn(
    "Preferences.instructions",
  )(
    function* (projectId) {
      yield* refreshWhenStale(yield* teamCatalog.snapshot);
      return (yield* read(projectId)).block ?? undefined;
    },
    // A cancelled run must stay cancelled; only a failed read degrades to no preferences.
    Effect.catchCauseIf(
      (cause) => !Cause.hasInterrupts(cause),
      (cause) =>
        Effect.logWarning("Preferences could not be read.", { cause }).pipe(Effect.as(undefined)),
    ),
  );

  const propose: Preferences["Service"]["propose"] = Effect.fn("Preferences.propose")(
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
          `Edits \`${target.file}\`, proposed from the Preferences panel.`,
          "Agents get the change on their next turn after this is merged.",
        ].join("\n\n"),
        branchStem:
          `preferences/${input.scope === "team" ? "team" : `${input.scope}-${name}`}`.slice(0, 80),
      });
    },
  );

  return Preferences.of({ read, changes, instructions, propose });
});

export const layer = Layer.effect(Preferences, make);
