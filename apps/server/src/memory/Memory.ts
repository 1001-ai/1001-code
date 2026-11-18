import {
  BOARD_ADD_TOOL_NAME,
  BOARD_LIST_TOOL_NAME,
  BOARD_UPDATE_TOOL_NAME,
  buildMemoryBlock,
  type MemoryCategory,
  type MemoryDecideInput,
  type MemoryDocument,
  type MemoryFileTarget,
  type MemoryProposal,
  type MemoryProposalDecision,
  type MemoryProposeInput,
  type MemoryScope,
  type MemoryView,
  memoryFile,
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
     */
    readonly proposeFromAgent: (input: {
      readonly projectId: ProjectId;
      readonly threadId: ThreadId;
      readonly threadTitle: string;
      readonly text: string;
      readonly reason: string;
      readonly category?: MemoryCategory | undefined;
      readonly replaces?: string | undefined;
    }) => Effect.Effect<MemoryProposal, TeamCatalogError>;
    /**
     * A person's answer, from the client session that clicked. Accepting adds the line to the file,
     * or in a category's file puts it in place of the one it replaces, and merges the pull request
     * at once; a failed push leaves the proposal unanswered.
     */
    readonly decide: (
      input: MemoryDecideInput,
      sessionId: string,
    ) => Effect.Effect<MemoryProposal, TeamCatalogError>;
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
    `Use ${BOARD_LIST_TOOL_NAME} to see its open tasks, ${BOARD_ADD_TOOL_NAME} to file a task and ${BOARD_UPDATE_TOOL_NAME} to change one (status, assignee, title or description). They act as the person you work for. Use the Linear connector only for what they do not cover, such as comments.`,
    `Once the requirements are clear and you are about to make your first change (a file edit, a branch or a worktree), the work needs a task on this board. Look for one that covers it. If none does, file one before that first change. Assign it to the person you work for (assignee "me") and set its status to In Progress. Even a small fix gets a task. Answering questions, reading code and planning need none.`,
    `This thread's link is ${link}. ${BOARD_ADD_TOOL_NAME} and ${BOARD_UPDATE_TOOL_NAME} attach it to the task, so the board and teammates' agents can find this thread; when you take over an existing task, update it with ${BOARD_UPDATE_TOOL_NAME}. Include the link in the "agent:" comments you write there too.`,
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

/** Adds the proposal as one list item at the end of the file. */
const appendMemoryLine = (fileText: string, line: string): string => {
  const item = line.startsWith("- ") ? line : `- ${line}`;
  return fileText.trim() === "" ? `${item}\n` : `${fileText.trimEnd()}\n${item}\n`;
};

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
    if (input.category !== undefined) {
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
      return yield* addProposal(input);
    }
    if (input.replaces !== undefined) {
      return yield* new TeamCatalogError({
        detail:
          "Only a voice agent memory replaces another one. Leave replaces out; other memories are added.",
      });
    }
    if ((yield* catalogProject(catalog, input.projectId)) === null) {
      return yield* new TeamCatalogError({
        detail: `${NOT_IN_CATALOG} There is nowhere to save memory for it.`,
      });
    }
    return yield* addProposal(input);
  });

  const addProposal = Effect.fn("Memory.addProposal")(function* (input: {
    readonly projectId: ProjectId;
    readonly threadId: ThreadId;
    readonly threadTitle: string;
    readonly text: string;
    readonly reason: string;
    readonly category?: MemoryCategory | undefined;
    readonly replaces?: string | undefined;
  }) {
    const text = input.text.trim();
    const existing = (yield* SubscriptionRef.get(proposalsRef)).find(
      (proposal) =>
        proposal.threadId === input.threadId &&
        proposal.text === text &&
        proposal.category === input.category &&
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
    };
    const next = yield* SubscriptionRef.updateAndGet(proposalsRef, (proposals) =>
      pruned([...proposals, proposal], input.projectId),
    );
    yield* proposalStore.save(next);
    return onWire(proposal);
  }, writeLock.withPermits(1));

  const record = Effect.fn("Memory.record")(function* (
    proposalId: string,
    decision: MemoryProposalDecision,
    sessionId: string,
  ) {
    const next = yield* SubscriptionRef.updateAndGet(proposalsRef, (proposals) =>
      proposals.map((proposal) =>
        proposal.id === proposalId
          ? { ...proposal, decision, decidedBySession: sessionId }
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
    const scope: MemoryScope = input.choice === "me" ? "personal-project" : "project";
    const target = yield* writableDocument(view, project, scope);
    if (view.revision === null || target === undefined) {
      return yield* new TeamCatalogError({ detail: NO_CATALOG });
    }
    if (target.file === null) {
      return yield* new TeamCatalogError({
        detail: target.unavailable ?? "This scope has no memory file here.",
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
    const line = input.text.trim();
    const origin = [
      `Proposed by an agent in the thread "${proposal.threadTitle}".`,
      ...(proposal.reason === "" ? [] : [`Its reason: ${proposal.reason}`]),
      "Accepted in 1001 Code, which merges it at once.",
    ];
    const change =
      proposal.category === undefined
        ? yield* appendedLine(input, line)
        : yield* supersededVoiceAgentMemory(input, proposal, line, decidedAt.slice(0, 10));
    const pullRequest = yield* teamCatalog.proposeFiles({
      baseRevision: change.baseRevision,
      files: [{ file: change.file, text: change.text }],
      title: change.title.slice(0, 200),
      body: [...change.body, ...origin].join("\n\n"),
      branchStem: change.branchStem.slice(0, 80),
    });
    const merge =
      pullRequest.pullRequestUrl === null
        ? {
            merged: false,
            problem: pullRequest.pullRequestProblem ?? "No pull request was opened.",
          }
        : yield* teamCatalog.mergeProposal(pullRequest.pullRequestUrl).pipe(
            Effect.as({ merged: true, problem: null }),
            Effect.catch((error) => Effect.succeed({ merged: false, problem: error.detail })),
          );
    return yield* record(
      proposal.id,
      {
        choice: input.choice,
        text: line,
        file: change.file,
        decidedAt,
        pullRequestUrl: pullRequest.pullRequestUrl,
        ...merge,
      },
      sessionId,
    );
  }, decideLock.withPermits(1));

  return Memory.of({
    read,
    changes,
    instructions,
    voiceAgentInstructions,
    voiceAgentEarlier,
    propose,
    proposeFromAgent,
    decide,
  });
});

export const layer = Layer.effect(Memory, make);
