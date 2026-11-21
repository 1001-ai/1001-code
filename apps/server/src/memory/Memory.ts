import {
  BOARD_ADD_TOOL_NAME,
  BOARD_LIST_TOOL_NAME,
  BOARD_MESSAGE_TOOL_NAME,
  BOARD_REPLY_TOOL_NAME,
  BOARD_UPDATE_TOOL_NAME,
  buildMemoryBlock,
  type MemoryCategory,
  type MemoryDecideInput,
  type MemoryDocument,
  type MemoryFileTarget,
  type MemoryProposal,
  type MemoryProposalDecision,
  type MemoryProposalKind,
  type MemoryUndoInput,
  type MemoryProposeInput,
  type MemoryScope,
  type MemoryView,
  memoryFile,
  type PendingMemoryProposal,
  type ProjectId,
  type TeamCatalogProject,
  type TeamCatalogProposal,
  TeamCatalogError,
  type TeamCatalogLinear,
  type TeamCatalogSnapshot,
  type TeamCatalogViewer,
  type ThreadId,
  teamCatalogRepositoryMatches,
  type VoiceAgentMemoryLogEntry,
  voiceAgentMemoryFile,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { threadLinkUrl } from "../board/linearBoard.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as TeamCatalog from "../teamCatalog/TeamCatalog.ts";
import { attributeLines } from "../teamCatalog/teamCatalogBlame.ts";
import { hostedRepositoryOf } from "../teamCatalog/teamCatalogProposal.ts";
import {
  appendMemoryLine,
  hasMemoryLine,
  memoryLineText,
  replaceMemoryLine,
} from "./memoryLines.ts";
import * as MemoryProposalStore from "./MemoryProposalStore.ts";
import {
  activeVoiceAgentMemory,
  buildVoiceAgentMemoryBlock,
  parseVoiceAgentMemories,
  supersedeVoiceAgentMemory,
} from "./voiceAgentMemories.ts";

/**
 * Memory: markdown files in the team catalog repository that every agent turn gets as one
 * `<memory>` block. People edit them through pull requests; agents propose single lines, which a
 * person accepts for themselves or the team.
 */
export class Memory extends Context.Service<
  Memory,
  {
    readonly read: (projectId: ProjectId) => Effect.Effect<MemoryView>;
    /** The view now, then again whenever the catalog or the project's proposals change. */
    readonly changes: (projectId: ProjectId) => Stream.Stream<MemoryView>;
    /**
     * Every project's unanswered proposals, newest first, now and on each change. Reads only the
     * proposals, never the catalog or its files.
     */
    readonly pendingChanges: Stream.Stream<ReadonlyArray<PendingMemoryProposal>>;
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
    /**
     * The signed-in person's active voice agent memories as the block the voice agent gets, or
     * undefined without a catalog or a login. No other agent gets it, and it is never part of
     * `instructions`. Never fails and never waits for git.
     */
    readonly voiceAgentInstructions: () => Effect.Effect<string | undefined>;
    /** The memories that person's newer ones replaced, newest first: the log, read on request. */
    readonly voiceAgentEarlier: () => Effect.Effect<ReadonlyArray<VoiceAgentMemoryLogEntry>>;
    /**
     * Records an agent's proposal, or returns the pending one the thread already made with it. With
     * a category it is for that category's file, where `replaces` names the memory it supersedes.
     * Otherwise `replaces` names a saved line in one of the project's memory files: with `text` the
     * proposal changes it, without it removes it.
     */
    readonly proposeFromAgent: (input: {
      readonly projectId: ProjectId;
      readonly threadId: ThreadId;
      readonly threadTitle: string;
      readonly text?: string | undefined;
      readonly reason: string;
      readonly category?: MemoryCategory | undefined;
      readonly replaces?: string | undefined;
    }) => Effect.Effect<MemoryProposal, TeamCatalogError>;
    /** The agent takes back a pending proposal its own thread made. */
    readonly withdraw: (input: {
      readonly threadId: ThreadId;
      readonly proposalId: string;
      readonly reason: string;
    }) => Effect.Effect<MemoryProposal, TeamCatalogError>;
    /**
     * A person's answer, from the client session that clicked. Accepting adds the line to the file,
     * edits the line a change or removal names in its own file, or in a category's file puts it in
     * place of the one it replaces, and merges the pull request at once; a failed push leaves the
     * proposal unanswered.
     */
    readonly decide: (
      input: MemoryDecideInput,
      sessionId: string,
    ) => Effect.Effect<MemoryProposal, TeamCatalogError>;
    /** Reverts what accepting a general proposal did, in the file it edited, and merges at once. */
    readonly undo: (input: MemoryUndoInput) => Effect.Effect<MemoryProposal, TeamCatalogError>;
  }
>()("t3/memory/Memory") {}

const SIGNED_OUT = "Sign in to the GitHub CLI with gh auth login to have personal memory.";
const NOT_IN_CATALOG = "This project is not in the team catalog.";
const NO_CATALOG = "No team catalog is set.";
/** Per project; the oldest answered ones go first, so the view stays small on the wire. */
const MAX_PROPOSALS_PER_PROJECT = 200;

/**
 * The board reads a thread from its task's link attachments, so a comment alone is not enough.
 * The board tools attach this thread's link themselves.
 */
export const boardInstructions = (linear: TeamCatalogLinear, link: string): string => {
  const board =
    linear.project === undefined
      ? `the ${linear.team} team in Linear`
      : `the Linear project "${linear.project}" in the ${linear.team} team`;
  return [
    "<board>",
    `This project's board is ${board}; its tasks are Linear issues. Use it for every task you read, file or update, unless the user names another board.`,
    `Use ${BOARD_LIST_TOOL_NAME} to see its open tasks, ${BOARD_ADD_TOOL_NAME} to file a task and ${BOARD_UPDATE_TOOL_NAME} to change one (status, assignee, title or description). They act as the person you work for. Use the Linear connector only for what they do not cover.`,
    `Once the requirements are clear and you are about to make your first change (a file edit, a branch or a worktree), the work needs a task on this board. Look for one that covers it. If none does, file one before that first change. Assign it to the person you work for (assignee "me") and set its status to In Progress. Even a small fix gets a task. Answering questions, reading code and planning need none.`,
    `This thread's link is ${link}. ${BOARD_ADD_TOOL_NAME} and ${BOARD_UPDATE_TOOL_NAME} attach it to the task, so the board and teammates' agents can find this thread; when you take over an existing task, update it with ${BOARD_UPDATE_TOOL_NAME}.`,
    `Talk to teammates' agents with ${BOARD_MESSAGE_TOOL_NAME} (a comment on a task, or on a teammate's Agent inbox when there is no task) and answer a teammate's comment delivered here with ${BOARD_REPLY_TOOL_NAME} and its commentId. Both write the "agent:" prefix and this thread's reply address for you, so answers come back here; write only what you mean to say. Do not use the Linear connector for these messages.`,
    "</board>",
  ].join("\n");
};

/** A document without its lines' authors, which only the panel shows. */
type MemoryDocumentText = Omit<MemoryDocument, "lines">;

/**
 * What a turn reads. The voice agent's memories and the lines' authors are left out: only the
 * panel's view adds them, so a turn never waits for git.
 */
type GeneralMemoryView = Omit<MemoryView, "voiceAgent" | "documents"> & {
  readonly documents: ReadonlyArray<MemoryDocumentText>;
};

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
    case "personal-project":
      return `Update personal memory in one project for ${label ?? "me"}`;
  }
};

const fileName = (file: string) => file.slice(file.lastIndexOf("/") + 1).replace(/\.md$/, "");

const onWire = ({
  projectId: _projectId,
  decidedBySession: _decidedBySession,
  ...proposal
}: MemoryProposalStore.StoredMemoryProposal): MemoryProposal => proposal;

/** Drops a project's oldest answered proposals past the cap; unanswered ones always stay. */
const pruned = (
  proposals: ReadonlyArray<MemoryProposalStore.StoredMemoryProposal>,
  projectId: ProjectId,
): ReadonlyArray<MemoryProposalStore.StoredMemoryProposal> => {
  const answered = proposals.filter(
    (proposal) => proposal.projectId === projectId && proposal.decision !== null,
  );
  const ownCount = proposals.filter((proposal) => proposal.projectId === projectId).length;
  const excess = new Set(
    answered
      .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt))
      .slice(0, Math.max(0, ownCount - MAX_PROPOSALS_PER_PROJECT))
      .map((proposal) => proposal.id),
  );
  return excess.size === 0 ? proposals : proposals.filter((proposal) => !excess.has(proposal.id));
};

const make = Effect.gen(function* () {
  const teamCatalog = yield* TeamCatalog.TeamCatalog;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const identities = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
  const environmentId = yield* (yield* ServerEnvironment.ServerEnvironment).getEnvironmentId;
  const proposalStore = yield* MemoryProposalStore.MemoryProposalStore;
  const proposalsRef = yield* SubscriptionRef.make(yield* proposalStore.load);
  const decideLock = yield* Semaphore.make(1);
  // Each change to the proposals and its save happen together, so saves never land out of order.
  const writeLock = yield* Semaphore.make(1);
  const random = yield* SecureRandom.SecureRandom;
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
    project: TeamCatalogProject | null,
    viewer: TeamCatalogViewer,
  ) {
    const login = viewer.login;
    const target: { readonly file: MemoryFileTarget; readonly label: string | null } | string =
      scope === "team"
        ? { file: { scope }, label: null }
        : scope === "project"
          ? project === null
            ? NOT_IN_CATALOG
            : { file: { scope, project: project.key }, label: project.name }
          : login === null
            ? (viewer.problem ?? SIGNED_OUT)
            : scope === "personal"
              ? { file: { scope, login }, label: login }
              : project === null
                ? NOT_IN_CATALOG
                : { file: { scope, project: project.key, login }, label: login };
    if (typeof target === "string") {
      return { scope, file: null, label: null, text: "", unavailable: target };
    }
    const file = memoryFile(target.file);
    const text = (yield* teamCatalog.readFile(file)) ?? "";
    return { scope, file, label: target.label, text, unavailable: null };
  });

  /** The viewer's own voice agent memories file, or why there is none. */
  const voiceAgentFile = Effect.fn("Memory.voiceAgentFile")(function* (
    source: string | null,
    viewer: TeamCatalogViewer,
  ) {
    if (source === null) return NO_CATALOG;
    if (viewer.login === null) return viewer.problem ?? SIGNED_OUT;
    const file = voiceAgentMemoryFile(viewer.login);
    return { file, login: viewer.login, text: (yield* teamCatalog.readFile(file)) ?? "" };
  });

  const projectProposals = (projectId: ProjectId) =>
    SubscriptionRef.get(proposalsRef).pipe(
      Effect.map((proposals) =>
        proposals
          .filter((proposal) => proposal.projectId === projectId)
          .toSorted((left, right) => right.createdAt.localeCompare(left.createdAt))
          .map(onWire),
      ),
    );

  const readWithProject = Effect.fn("Memory.read")(function* (projectId: ProjectId) {
    const catalog = yield* teamCatalog.snapshot;
    const base = {
      source: catalog.source,
      revision: catalog.revision,
      fetchedAt: catalog.fetchedAt,
      refreshing: catalog.refreshing,
      error: catalog.error,
      viewer: catalog.viewer,
      proposals: yield* projectProposals(projectId),
    };
    if (catalog.source === null) {
      const view: GeneralMemoryView = { ...base, documents: [], block: null, truncated: false };
      return { view, project: null };
    }
    const project = yield* catalogProject(catalog, projectId);
    const documents = [
      yield* document("team", project, catalog.viewer),
      yield* document("project", project, catalog.viewer),
      yield* document("personal", project, catalog.viewer),
      yield* document("personal-project", project, catalog.viewer),
    ];
    const block = buildMemoryBlock({
      documents,
      repository: hostedRepositoryOf(catalog.source),
      proposable: project !== null,
    });
    const view: GeneralMemoryView = {
      ...base,
      documents,
      block: block?.text ?? null,
      truncated: block?.truncated ?? false,
    };
    return { view, project };
  });

  const read: Memory["Service"]["read"] = Effect.fn("Memory.readView")(function* (projectId) {
    const { view } = yield* readWithProject(projectId);
    const documents = yield* Effect.forEach(view.documents, (document) =>
      document.file === null || document.text === ""
        ? Effect.succeed({ ...document, lines: [] })
        : teamCatalog
            .blame(document.file)
            .pipe(
              Effect.map((blame) => ({ ...document, lines: attributeLines(document.text, blame) })),
            ),
    );
    const own = yield* voiceAgentFile(view.source, view.viewer);
    const voiceAgent: MemoryView["voiceAgent"] =
      typeof own === "string"
        ? { file: null, unavailable: own, active: [], earlier: [] }
        : { file: own.file, unavailable: null, ...parseVoiceAgentMemories(own.text) };
    return { ...view, documents, voiceAgent };
  });

  const changes: Memory["Service"]["changes"] = (projectId) =>
    Stream.merge(teamCatalog.changes, SubscriptionRef.changes(proposalsRef)).pipe(
      Stream.mapEffect(() => read(projectId)),
      Stream.changesWith((a, b) => JSON.stringify(a) === JSON.stringify(b)),
    );

  const pendingChanges: Memory["Service"]["pendingChanges"] = SubscriptionRef.changes(
    proposalsRef,
  ).pipe(
    Stream.map((proposals) =>
      proposals
        .filter((proposal) => proposal.decision === null)
        .toSorted((left, right) => right.createdAt.localeCompare(left.createdAt))
        .map((proposal) => ({ projectId: proposal.projectId, proposal: onWire(proposal) })),
    ),
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
      const board = boardInstructions(project.linear, threadLinkUrl(environmentId, threadId));
      return view.block === null ? board : `${view.block}\n\n${board}`;
    },
    // A cancelled run must stay cancelled; only a failed read degrades to no memory.
    Effect.catchCauseIf(
      (cause) => !Cause.hasInterrupts(cause),
      (cause) =>
        Effect.logWarning("Memory could not be read.", { cause }).pipe(Effect.as(undefined)),
    ),
  );

  const voiceAgentMemories = Effect.fn("Memory.voiceAgentMemories")(
    function* () {
      const catalog = yield* teamCatalog.snapshot;
      yield* refreshWhenStale(catalog);
      const own = yield* voiceAgentFile(catalog.source, catalog.viewer);
      return typeof own === "string" ? undefined : parseVoiceAgentMemories(own.text);
    },
    // As for `instructions`: a failed read degrades to nothing, a cancelled one stays cancelled.
    Effect.catchCauseIf(
      (cause) => !Cause.hasInterrupts(cause),
      (cause) =>
        Effect.logWarning("Voice agent memories could not be read.", { cause }).pipe(
          Effect.as(undefined),
        ),
    ),
  );

  const voiceAgentInstructions: Memory["Service"]["voiceAgentInstructions"] = () =>
    voiceAgentMemories().pipe(
      Effect.map((file) =>
        file === undefined ? undefined : buildVoiceAgentMemoryBlock(file.active).text,
      ),
    );

  const voiceAgentEarlier: Memory["Service"]["voiceAgentEarlier"] = () =>
    voiceAgentMemories().pipe(Effect.map((file) => file?.earlier ?? []));

  // A personal file is the live login's: after a GitHub CLI account switch the cached one would
  // edit the previous person's file under the new author.
  const writableDocument = Effect.fn("Memory.writableDocument")(function* (
    view: GeneralMemoryView,
    project: TeamCatalogProject | null,
    scope: MemoryScope,
  ) {
    if (view.source === null) return undefined;
    if (scope !== "personal" && scope !== "personal-project") {
      return view.documents.find((candidate) => candidate.scope === scope);
    }
    return yield* document(scope, project, yield* teamCatalog.liveViewer);
  });

  const propose: Memory["Service"]["propose"] = Effect.fn("Memory.propose")(function* (input) {
    const { view, project } = yield* readWithProject(input.projectId);
    const target = yield* writableDocument(view, project, input.scope);
    if (view.source === null || target === undefined) {
      return yield* new TeamCatalogError({ detail: NO_CATALOG });
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

  const proposeFromAgent: Memory["Service"]["proposeFromAgent"] = Effect.fn(
    "Memory.proposeFromAgent",
  )(function* (input) {
    const catalog = yield* teamCatalog.snapshot;
    if (catalog.source === null) {
      return yield* new TeamCatalogError({
        detail: "No team catalog is set, so there is nowhere to save memory.",
      });
    }
    const text = input.text?.trim() ?? "";
    if (input.category !== undefined) {
      if (text === "") {
        return yield* new TeamCatalogError({ detail: "Give the voice agent memory as text." });
      }
      // The category's file is the person's own, so the project need not be in the catalog.
      // The live login, as accepting uses: a cached one would check `replaces` against another person's file.
      const own = yield* voiceAgentFile(catalog.source, yield* teamCatalog.liveViewer);
      if (typeof own === "string") return yield* new TeamCatalogError({ detail: own });
      const file = parseVoiceAgentMemories(own.text);
      if (input.replaces !== undefined && activeVoiceAgentMemory(file, input.replaces) === null) {
        const active = file.active.map((memory) => JSON.stringify(memory.text)).join(", ");
        return yield* new TeamCatalogError({
          detail: `No voice agent memory has the text given as replaces. ${active === "" ? "None is active, so leave replaces out." : `Give the exact text of one of the active ones: ${active}. Leave replaces out for a new subject.`}`,
        });
      }
      return yield* addProposal({ ...input, text });
    }
    if (input.replaces !== undefined) {
      return yield* proposeEdit({ ...input, text, replaces: input.replaces });
    }
    const normalized = memoryLineText(text);
    if (normalized === "") {
      return yield* new TeamCatalogError({
        detail:
          "Give text for a new memory, or replaces with the exact text of a saved memory line to change it (with text) or remove it (without text).",
      });
    }
    const { view, project } = yield* readWithProject(input.projectId);
    if (project === null) {
      return yield* new TeamCatalogError({
        detail: `${NOT_IN_CATALOG} There is nowhere to save memory for it.`,
      });
    }
    const documents = yield* Effect.forEach(
      ["team", "project", "personal", "personal-project"] as const,
      (scope) => writableDocument(view, project, scope),
    );
    const savedIn = documents.find(
      (candidate) =>
        candidate !== undefined &&
        candidate.file !== null &&
        hasMemoryLine(candidate.text, normalized),
    );
    if (savedIn !== undefined && savedIn.file !== null) {
      return yield* new TeamCatalogError({
        detail: `This memory is already saved in ${savedIn.file}.`,
      });
    }
    const pendingElsewhere = (yield* SubscriptionRef.get(proposalsRef)).find(
      (proposal) =>
        proposal.projectId === input.projectId &&
        proposal.threadId !== input.threadId &&
        proposal.category === undefined &&
        proposal.kind === undefined &&
        proposal.decision === null &&
        memoryLineText(proposal.text) === normalized,
    );
    if (pendingElsewhere !== undefined) {
      return yield* new TeamCatalogError({
        detail:
          "Another thread in this project already proposed this memory and it is waiting for review.",
      });
    }
    return yield* addProposal({ ...input, text: normalized });
  });

  /** A change or removal of a saved line, which must be in exactly one of the project's files. */
  const proposeEdit = Effect.fn("Memory.proposeEdit")(function* (input: {
    readonly projectId: ProjectId;
    readonly threadId: ThreadId;
    readonly threadTitle: string;
    readonly text: string;
    readonly reason: string;
    readonly replaces: string;
  }) {
    const replaces = memoryLineText(input.replaces);
    const { view, project } = yield* readWithProject(input.projectId);
    const documents = yield* Effect.forEach(
      ["team", "project", "personal", "personal-project"] as const,
      (scope) => writableDocument(view, project, scope),
    );
    const found = documents.flatMap((document) =>
      document !== undefined && document.file !== null && hasMemoryLine(document.text, replaces)
        ? [document]
        : [],
    );
    const where = found[0];
    if (replaces === "" || where === undefined || where.file === null) {
      return yield* new TeamCatalogError({
        detail:
          "No saved memory line has the text given as replaces. Give the exact text of an existing memory line, without its list bullet, or leave replaces out to add a new memory.",
      });
    }
    if (found.length > 1) {
      return yield* new TeamCatalogError({
        detail: `That line is saved in more than one memory file (${found.map((document) => document.scope).join(", ")}). Give a line that is saved only once, or ask the user to edit it in the Memory panel.`,
      });
    }
    if (memoryLineText(input.text) === replaces) {
      return yield* new TeamCatalogError({
        detail: "The text is the same as the line it replaces. Leave text out to remove the line.",
      });
    }
    const kind: MemoryProposalKind = input.text === "" ? "remove" : "change";
    return yield* addProposal({
      ...input,
      text: kind === "remove" ? replaces : memoryLineText(input.text),
      replaces,
      kind,
      scope: where.scope,
      file: where.file,
    });
  });

  const addProposal = Effect.fn("Memory.addProposal")(function* (input: {
    readonly projectId: ProjectId;
    readonly threadId: ThreadId;
    readonly threadTitle: string;
    readonly text: string;
    readonly reason: string;
    readonly category?: MemoryCategory | undefined;
    readonly replaces?: string | undefined;
    readonly kind?: MemoryProposalKind | undefined;
    readonly scope?: MemoryScope | undefined;
    readonly file?: string | undefined;
  }) {
    const text = input.text.trim();
    const existing = (yield* SubscriptionRef.get(proposalsRef)).find(
      (proposal) =>
        proposal.threadId === input.threadId &&
        proposal.text === text &&
        proposal.category === input.category &&
        proposal.kind === input.kind &&
        (input.kind === undefined || proposal.replaces === input.replaces) &&
        proposal.decision === null,
    );
    if (existing !== undefined) return onWire(existing);
    const proposal: MemoryProposalStore.StoredMemoryProposal = {
      id: yield* random.uuidV4(),
      projectId: input.projectId,
      threadId: input.threadId,
      threadTitle: input.threadTitle,
      text,
      reason: input.reason.trim(),
      createdAt: DateTime.formatIso(yield* DateTime.now),
      decision: null,
      decidedBySession: null,
      ...(input.category === undefined ? {} : { category: input.category }),
      ...(input.replaces === undefined ? {} : { replaces: input.replaces.trim() }),
      ...(input.kind === undefined ? {} : { kind: input.kind }),
      ...(input.scope === undefined ? {} : { scope: input.scope }),
      ...(input.file === undefined ? {} : { file: input.file }),
    };
    const next = yield* SubscriptionRef.updateAndGet(proposalsRef, (proposals) =>
      pruned([...proposals, proposal], input.projectId),
    );
    yield* proposalStore.save(next);
    return onWire(proposal);
  }, writeLock.withPermits(1));

  /** Without a session the one that decided it stays: an undo is recorded on its decision. */
  const record = Effect.fn("Memory.record")(function* (
    proposalId: string,
    decision: MemoryProposalDecision,
    sessionId?: string | null,
  ) {
    const next = yield* SubscriptionRef.updateAndGet(proposalsRef, (proposals) =>
      proposals.map((proposal) =>
        proposal.id === proposalId
          ? {
              ...proposal,
              decision,
              ...(sessionId === undefined ? {} : { decidedBySession: sessionId }),
            }
          : proposal,
      ),
    );
    yield* proposalStore.save(next);
    const decided = next.find((proposal) => proposal.id === proposalId);
    if (decided === undefined) {
      return yield* new TeamCatalogError({ detail: "This proposal was not found." });
    }
    return onWire(decided);
  }, writeLock.withPermits(1));

  /** Accept for me or for the team: the line joins the end of that file. */
  const appendedLine = Effect.fn("Memory.appendedLine")(function* (
    input: MemoryDecideInput,
    line: string,
  ) {
    const { view, project } = yield* readWithProject(input.projectId);
    const scope: MemoryScope =
      input.scope ?? (input.choice === "me" ? "personal-project" : "project");
    if (
      (input.choice === "me" && scope !== "personal" && scope !== "personal-project") ||
      (input.choice === "team" && scope !== "team" && scope !== "project")
    ) {
      return yield* new TeamCatalogError({
        detail:
          input.choice === "me"
            ? "Accept for me can save only to your personal or personal-project memory."
            : "Accept for team can save only to team or project memory.",
      });
    }
    const target = yield* writableDocument(view, project, scope);
    if (view.revision === null || target === undefined) {
      return yield* new TeamCatalogError({ detail: NO_CATALOG });
    }
    if (target.file === null) {
      return yield* new TeamCatalogError({
        detail: target.unavailable ?? "This scope has no memory file here.",
      });
    }
    if (hasMemoryLine(target.text, line)) {
      return yield* new TeamCatalogError({
        detail: `Nothing to save: this memory is already in ${target.file}.`,
      });
    }
    return {
      baseRevision: view.revision,
      file: target.file,
      text: appendMemoryLine(target.text, line),
      title: `${input.choice === "me" ? "Remember for me" : "Remember for the team"}: ${line}`,
      body: [`Adds to \`${target.file}\`:`, `> ${line}`],
      branchStem: `memory/${scope}-${target.file
        .slice(target.file.lastIndexOf("/") + 1)
        .replace(/\.md$/, "")}`,
    };
  });

  /** A voice agent memory goes to the live login's own file, in place of the one it replaces. */
  const supersededVoiceAgentMemory = Effect.fn("Memory.supersededVoiceAgentMemory")(function* (
    input: MemoryDecideInput,
    proposal: MemoryProposal,
    line: string,
    today: string,
  ) {
    if (input.choice === "team") {
      return yield* new TeamCatalogError({
        detail: "A voice agent memory is yours alone: accept it for yourself or reject it.",
      });
    }
    const catalog = yield* teamCatalog.snapshot;
    const own = yield* voiceAgentFile(catalog.source, yield* teamCatalog.liveViewer);
    if (catalog.revision === null || typeof own === "string") {
      return yield* new TeamCatalogError({ detail: typeof own === "string" ? own : NO_CATALOG });
    }
    const next = supersedeVoiceAgentMemory(own.text, {
      text: line,
      replaces: proposal.replaces ?? null,
      today,
    });
    if (!next.changed) {
      return yield* new TeamCatalogError({
        detail: "Nothing to save: this voice agent memory is already active.",
      });
    }
    return {
      baseRevision: catalog.revision,
      file: own.file,
      text: next.text,
      title: `Remember for the voice agent: ${line}`,
      body: [
        `Adds to \`${own.file}\`:`,
        `> ${line}`,
        ...(next.replaced === null
          ? []
          : ["It replaces this memory, which moves to the file's log:", `> ${next.replaced}`]),
      ],
      branchStem: `memory/voice-agent-${own.login.toLowerCase()}`,
    };
  });

  /** A change or removal edits the line where it was found when it was proposed. */
  const editedLine = Effect.fn("Memory.editedLine")(function* (
    proposal: MemoryProposal,
    line: string,
  ) {
    const catalog = yield* teamCatalog.snapshot;
    const { file, replaces } = proposal;
    if (catalog.revision === null || file === undefined || replaces === undefined) {
      return yield* new TeamCatalogError({ detail: NO_CATALOG });
    }
    const removal = proposal.kind === "remove";
    const text = replaceMemoryLine(
      (yield* teamCatalog.readFile(file)) ?? "",
      replaces,
      removal ? null : line,
    );
    if (text === null) {
      return yield* new TeamCatalogError({
        detail: "This memory changed since it was proposed; reject this proposal.",
      });
    }
    return {
      baseRevision: catalog.revision,
      file,
      text,
      title: removal ? `Remove a memory: ${replaces}` : `Change a memory: ${line}`,
      body: removal
        ? [`Removes from \`${file}\`:`, `> ${replaces}`]
        : [`Changes in \`${file}\`:`, `> ${replaces}`, "to:", `> ${line}`],
      branchStem: `memory/${proposal.kind}-${fileName(file)}`,
    };
  });

  /** Opens the pull request and merges it at once; a refused merge leaves it open and says why. */
  const proposeAndMerge = Effect.fn("Memory.proposeAndMerge")(function* (
    change: {
      readonly baseRevision: string;
      readonly file: string;
      readonly text: string;
      readonly title: string;
      readonly body: ReadonlyArray<string>;
      readonly branchStem: string;
    },
    origin: ReadonlyArray<string>,
  ) {
    const pullRequest = yield* teamCatalog.proposeFiles({
      baseRevision: change.baseRevision,
      files: [{ file: change.file, text: change.text }],
      title: change.title.slice(0, 200),
      body: [...change.body, ...origin].join("\n\n"),
      branchStem: change.branchStem.slice(0, 80),
    });
    const url = pullRequest.pullRequestUrl;
    const merge: { readonly merged: boolean; readonly problem: string | null } =
      url === null
        ? {
            merged: false,
            problem: pullRequest.pullRequestProblem ?? "No pull request was opened.",
          }
        : yield* teamCatalog.mergeProposal(url).pipe(
            Effect.as({ merged: true, problem: null }),
            Effect.catch((error) => Effect.succeed({ merged: false, problem: error.detail })),
          );
    return { pullRequestUrl: url, ...merge };
  });

  const decide: Memory["Service"]["decide"] = Effect.fn("Memory.decide")(function* (
    input,
    sessionId,
  ) {
    const proposal = (yield* SubscriptionRef.get(proposalsRef)).find(
      (candidate) => candidate.id === input.proposalId && candidate.projectId === input.projectId,
    );
    if (proposal === undefined) {
      return yield* new TeamCatalogError({ detail: "This proposal was not found." });
    }
    if (proposal.decision !== null) {
      return yield* new TeamCatalogError({ detail: "This proposal was already answered." });
    }
    const edit = proposal.kind !== undefined;
    if (input.choice !== "reject" && edit !== (input.choice === "accept")) {
      return yield* new TeamCatalogError({
        detail: edit
          ? "This proposal edits a saved memory in its own file: accept it or reject it."
          : "Choose who this memory is for: accept it for yourself or the team, or reject it.",
      });
    }
    const decidedAt = DateTime.formatIso(yield* DateTime.now);
    if (input.choice === "reject") {
      return yield* record(
        proposal.id,
        {
          choice: "reject",
          text: null,
          file: null,
          decidedAt,
          pullRequestUrl: null,
          merged: false,
          problem: null,
        },
        sessionId,
      );
    }

    // Start from the newest catalog, so the pull request rarely meets a moved file.
    yield* teamCatalog.refresh({ force: true });
    const line = edit ? memoryLineText(input.text) : input.text.trim();
    const origin = [
      `Proposed by an agent in the thread "${proposal.threadTitle}".`,
      ...(proposal.reason === "" ? [] : [`Its reason: ${proposal.reason}`]),
      "Accepted in 1001 Code, which merges it at once.",
    ];
    const change = edit
      ? yield* editedLine(proposal, line)
      : proposal.category === undefined
        ? yield* appendedLine(input, line)
        : yield* supersededVoiceAgentMemory(input, proposal, line, decidedAt.slice(0, 10));
    const pullRequest = yield* proposeAndMerge(change, origin);
    return yield* record(
      proposal.id,
      {
        choice: input.choice,
        text: proposal.kind === "remove" ? null : line,
        file: change.file,
        decidedAt,
        ...pullRequest,
      },
      sessionId,
    );
  }, decideLock.withPermits(1));

  // Under the decide lock, so a withdrawal never lands on a proposal a person is accepting.
  const withdraw: Memory["Service"]["withdraw"] = Effect.fn("Memory.withdraw")(function* (input) {
    const proposal = (yield* SubscriptionRef.get(proposalsRef)).find(
      (candidate) => candidate.id === input.proposalId,
    );
    if (proposal === undefined) {
      return yield* new TeamCatalogError({ detail: "No memory proposal has this proposalId." });
    }
    if (proposal.threadId !== input.threadId) {
      return yield* new TeamCatalogError({
        detail: "Only the thread that proposed this memory can withdraw it.",
      });
    }
    if (proposal.decision !== null) {
      return yield* new TeamCatalogError({
        detail: "This proposal was already answered, so it can no longer be withdrawn.",
      });
    }
    return yield* record(
      proposal.id,
      {
        choice: "withdrawn",
        text: null,
        file: null,
        decidedAt: DateTime.formatIso(yield* DateTime.now),
        pullRequestUrl: null,
        merged: false,
        problem: null,
        reason: input.reason.trim(),
      },
      null,
    );
  }, decideLock.withPermits(1));

  const undo: Memory["Service"]["undo"] = Effect.fn("Memory.undo")(function* (input) {
    const proposal = (yield* SubscriptionRef.get(proposalsRef)).find(
      (candidate) => candidate.id === input.proposalId && candidate.projectId === input.projectId,
    );
    if (proposal === undefined) {
      return yield* new TeamCatalogError({ detail: "This proposal was not found." });
    }
    const decision = proposal.decision;
    if (
      decision === null ||
      decision.file === null ||
      decision.choice === "reject" ||
      decision.choice === "withdrawn" ||
      proposal.category !== undefined
    ) {
      return yield* new TeamCatalogError({ detail: "Only an accepted memory can be undone." });
    }
    if (decision.undo !== undefined) {
      return yield* new TeamCatalogError({ detail: "This memory was already undone." });
    }
    if (!decision.merged) {
      return yield* new TeamCatalogError({
        detail: "This memory was never merged, so there is nothing to undo.",
      });
    }
    yield* teamCatalog.refresh({ force: true });
    const catalog = yield* teamCatalog.snapshot;
    if (catalog.revision === null) return yield* new TeamCatalogError({ detail: NO_CATALOG });
    const file = decision.file;
    const current = (yield* teamCatalog.readFile(file)) ?? "";
    const old = proposal.replaces ?? "";
    const saved = decision.text ?? "";
    const revert =
      proposal.kind === "remove"
        ? {
            text: hasMemoryLine(current, old) ? null : appendMemoryLine(current, old),
            gone: `The removed memory is already back in ${file}.`,
            title: `Restore a memory: ${old}`,
            body: [`Adds back to \`${file}\`:`, `> ${old}`],
          }
        : proposal.kind === "change"
          ? {
              text: replaceMemoryLine(current, saved, old),
              gone: `The changed memory is no longer in ${file}, so it cannot be changed back.`,
              title: `Change a memory back: ${old}`,
              body: [`Changes in \`${file}\`:`, `> ${saved}`, "back to:", `> ${old}`],
            }
          : {
              text: replaceMemoryLine(current, saved, null),
              gone: `This memory is no longer in ${file}, so there is nothing to undo.`,
              title: `Forget a memory: ${saved}`,
              body: [`Removes from \`${file}\`:`, `> ${saved}`],
            };
    if (revert.text === null) return yield* new TeamCatalogError({ detail: revert.gone });
    const undoneAt = DateTime.formatIso(yield* DateTime.now);
    const pullRequest = yield* proposeAndMerge(
      {
        baseRevision: catalog.revision,
        file,
        text: revert.text,
        title: revert.title,
        body: revert.body,
        branchStem: `memory/undo-${fileName(file)}`,
      },
      [
        `Undoes ${decision.pullRequestUrl ?? "a memory"} proposed by an agent in the thread "${proposal.threadTitle}".`,
        "Undone in 1001 Code, which merges it at once.",
      ],
    );
    return yield* record(proposal.id, { ...decision, undo: { undoneAt, ...pullRequest } });
  }, decideLock.withPermits(1));

  return Memory.of({
    read,
    changes,
    pendingChanges,
    instructions,
    voiceAgentInstructions,
    voiceAgentEarlier,
    propose,
    proposeFromAgent,
    withdraw,
    decide,
    undo,
  });
});

export const layer = Layer.effect(Memory, make);
