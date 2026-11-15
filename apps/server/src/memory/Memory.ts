import {
  buildMemoryBlock,
  type ProjectId,
  type TeamCatalogProposal,
  TeamCatalogError,
  type TeamCatalogSnapshot,
  type MemoryDocument,
  type MemoryProposeInput,
  type MemoryScope,
  type MemoryView,
  type ThreadId,
  teamCatalogRepositoryMatches,
  memoryFile,
} from "@t3tools/contracts";
import { THREAD_LINK_PROTOCOL } from "@t3tools/shared/threadLinks";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as TeamCatalog from "../teamCatalog/TeamCatalog.ts";
import { hostedRepositoryOf } from "../teamCatalog/teamCatalogProposal.ts";

/**
 * Memory: markdown files in the team catalog repository that every agent turn gets as
 * one `<memory>` block. Changes are proposed to the catalog as pull requests.
 */
export class Memory extends Context.Service<
  Memory,
  {
    readonly read: (projectId: ProjectId) => Effect.Effect<MemoryView>;
    /** The view now, then again whenever the catalog changes. */
    readonly changes: (projectId: ProjectId) => Stream.Stream<MemoryView>;
    /**
     * The block for a turn in the project, or undefined when there is none. Never fails and never
     * waits for git: a stale catalog is refreshed in the background for later turns.
     */
    readonly instructions: (
      projectId: ProjectId,
      threadId: ThreadId,
    ) => Effect.Effect<string | undefined>;
    readonly propose: (
      input: MemoryProposeInput,
    ) => Effect.Effect<TeamCatalogProposal, TeamCatalogError>;
  }
>()("t3/memory/Memory") {}

const SIGNED_OUT = "Sign in to the GitHub CLI with gh auth login to have personal memory.";

/** The board reads a thread from an issue's link attachments, so a comment alone is not enough. */
const threadLinkInstructions = (link: string): string =>
  [
    "<thread_link>",
    `This thread's link is ${link}. When you work on an issue on this project's Linear board, add this link to that issue once, as a link attachment (not only in a comment), so the board and teammates' agents can find this thread. Include it in the "agent:" comments you write there too.`,
    "</thread_link>",
  ].join("\n");

/** Turns use the cached catalog; one older than this starts a background fetch. */
const STALE_AFTER_MS = 10 * 60_000;

const proposalTitle = (scope: MemoryScope, label: string | null): string => {
  switch (scope) {
    case "team":
      return "Update team memory";
    case "project":
      return `Update memory for ${label ?? "the project"}`;
    case "personal":
      return `Update personal memory for ${label ?? "me"}`;
  }
};

const make = Effect.gen(function* () {
  const teamCatalog = yield* TeamCatalog.TeamCatalog;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const identities = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
  const environmentId = yield* (yield* ServerEnvironment.ServerEnvironment).getEnvironmentId;
  const backgroundScope = yield* Scope.make();
  yield* Effect.addFinalizer(() => Scope.close(backgroundScope, Exit.void));
  let lastStaleRefreshMs = 0;

  const catalogProject = Effect.fn("Memory.catalogProject")(function* (
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

  const document = Effect.fn("Memory.document")(function* (
    scope: MemoryScope,
    target: { readonly key: string; readonly label: string | null } | string,
  ) {
    if (typeof target === "string") {
      return { scope, file: null, label: null, text: "", unavailable: target };
    }
    const file = memoryFile(scope, target.key);
    const text = (yield* teamCatalog.readFile(file)) ?? "";
    return { scope, file, label: target.label, text, unavailable: null };
  });

  const readWithProject = Effect.fn("Memory.read")(function* (projectId: ProjectId) {
    const catalog = yield* teamCatalog.snapshot;
    const base = {
      source: catalog.source,
      revision: catalog.revision,
      refreshing: catalog.refreshing,
      error: catalog.error,
      viewer: catalog.viewer,
    };
    if (catalog.source === null) {
      const view: MemoryView = { ...base, documents: [], block: null, truncated: false };
      return { view, project: null };
    }
    const project = yield* catalogProject(catalog, projectId);
    const login = catalog.viewer.login;
    const documents: ReadonlyArray<MemoryDocument> = [
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
    const block = buildMemoryBlock({
      documents,
      repository: hostedRepositoryOf(catalog.source),
    });
    const view: MemoryView = {
      ...base,
      documents,
      block: block?.text ?? null,
      truncated: block?.truncated ?? false,
    };
    return { view, project };
  });

  const read: Memory["Service"]["read"] = (projectId) =>
    readWithProject(projectId).pipe(Effect.map(({ view }) => view));

  const changes: Memory["Service"]["changes"] = (projectId) =>
    teamCatalog.changes.pipe(
      Stream.mapEffect(() => read(projectId)),
      Stream.changesWith((a, b) => JSON.stringify(a) === JSON.stringify(b)),
    );

  const refreshWhenStale = Effect.fn("Memory.refreshWhenStale")(function* (
    catalog: TeamCatalogSnapshot,
  ) {
    if (catalog.source === null || catalog.refreshing) return;
    const now = yield* Clock.currentTimeMillis;
    const fetchedAt = catalog.fetchedAt === null ? 0 : Date.parse(catalog.fetchedAt);
    if (now - fetchedAt < STALE_AFTER_MS || now - lastStaleRefreshMs < STALE_AFTER_MS) return;
    lastStaleRefreshMs = now;
    yield* teamCatalog.refresh().pipe(Effect.forkIn(backgroundScope));
  });

  const instructions: Memory["Service"]["instructions"] = Effect.fn("Memory.instructions")(
    function* (projectId, threadId) {
      yield* refreshWhenStale(yield* teamCatalog.snapshot);
      const { view, project } = yield* readWithProject(projectId);
      if (project?.linear === undefined) return view.block ?? undefined;
      const link = `${THREAD_LINK_PROTOCOL}://v2/${environmentId}/${threadId}`;
      const threadLink = threadLinkInstructions(link);
      return view.block === null ? threadLink : `${view.block}\n\n${threadLink}`;
    },
    // A cancelled run must stay cancelled; only a failed read degrades to no memory.
    Effect.catchCauseIf(
      (cause) => !Cause.hasInterrupts(cause),
      (cause) =>
        Effect.logWarning("Memory could not be read.", { cause }).pipe(Effect.as(undefined)),
    ),
  );

  const propose: Memory["Service"]["propose"] = Effect.fn("Memory.propose")(function* (input) {
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
        detail: target.unavailable ?? "This scope has no memory file here.",
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
        `Edits \`${target.file}\`, proposed from the Memory panel.`,
        "Agents get the change on their next turn after this is merged.",
      ].join("\n\n"),
      branchStem: `memory/${input.scope === "team" ? "team" : `${input.scope}-${name}`}`.slice(
        0,
        80,
      ),
    });
  });

  return Memory.of({ read, changes, instructions, propose });
});

export const layer = Layer.effect(Memory, make);
