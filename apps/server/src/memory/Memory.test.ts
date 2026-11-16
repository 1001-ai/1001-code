import {
  EnvironmentId,
  ProjectId,
  type RepositoryIdentity,
  TeamCatalogError,
  type TeamCatalogLinear,
  type TeamCatalogProposal,
  type TeamCatalogSnapshot,
  ThreadId,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Deferred from "effect/Deferred";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as TeamCatalog from "../teamCatalog/TeamCatalog.ts";
import * as Memory from "./Memory.ts";
import * as MemoryProposalStore from "./MemoryProposalStore.ts";

const PROJECT_ID = ProjectId.make("project-web");
const THREAD_ID = ThreadId.make("thread-1");

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
  "memory/team.md": "- Prefer small pull requests.\n",
  "memory/projects/web.md": "- Run the web tests before pushing.\n",
  "memory/people/alice.md": "- Keep replies short.\n",
  "memory/people/bob.md": "- Bob's own rule.\n",
  "memory/people/alice/voice-agent-memories.md": [
    "# Voice agent memories",
    "",
    "- Keep updates to one sentence per agent. (saved 2026-03-09)",
    "",
    "## Earlier",
    "",
    "- Give a paragraph per agent. (saved 2026-03-02, replaced 2026-03-09 by: Keep updates to one sentence per agent.)",
    "",
  ].join("\n"),
  "memory/people/bob/voice-agent-memories.md": "- Bob wants every detail.\n",
};
const VOICE_FILE = "memory/people/alice/voice-agent-memories.md";

const makeMemory = (input: {
  readonly catalog: TeamCatalogSnapshot;
  readonly identity?: RepositoryIdentity | null;
  readonly readFile?: TeamCatalog.TeamCatalog["Service"]["readFile"];
  readonly refreshed?: Deferred.Deferred<void>;
  /** The GitHub CLI's login now, when it differs from the one the snapshot cached. */
  readonly liveLogin?: string | null;
  /** What the proposal store holds when the service starts, as after a restart. */
  readonly stored?: ReadonlyArray<MemoryProposalStore.StoredMemoryProposal>;
  readonly pushFails?: string;
  /** Holds the first save until `release`, as a slow disk would. */
  readonly slowFirstSave?: {
    readonly started: Deferred.Deferred<void>;
    readonly release: Deferred.Deferred<void>;
  };
  readonly mergeFails?: string;
}) => {
  const proposals: Array<TeamCatalog.TeamCatalogFilesProposal> = [];
  const merged: Array<string> = [];
  const reads: Array<string> = [];
  const store = { saved: input.stored ?? [], saves: 0 };
  const build = Memory.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        SecureRandom.layerWebCrypto,
        Layer.mock(MemoryProposalStore.MemoryProposalStore)({
          load: Effect.sync(() => store.saved),
          save: (next) =>
            Effect.gen(function* () {
              store.saves += 1;
              if (store.saves === 1 && input.slowFirstSave !== undefined) {
                yield* Deferred.succeed(input.slowFirstSave.started, undefined);
                yield* Deferred.await(input.slowFirstSave.release);
              }
              store.saved = next;
            }),
        }),
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
              Effect.sync(() => {
                reads.push(file);
                return input.catalog.source === null ? null : (FILES[file] ?? null);
              })),
          refresh: () =>
            (input.refreshed === undefined
              ? Effect.void
              : Deferred.succeed(input.refreshed, undefined)
            ).pipe(Effect.as(input.catalog)),
          mergeProposal: (url) =>
            input.mergeFails === undefined
              ? Effect.sync(() => {
                  merged.push(url);
                })
              : Effect.fail(new TeamCatalogError({ detail: input.mergeFails })),
          proposeFiles: (proposal) =>
            input.pushFails !== undefined
              ? Effect.fail(new TeamCatalogError({ detail: input.pushFails }))
              : Effect.sync(() => {
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
        Layer.mock(ServerEnvironment.ServerEnvironment)({
          getEnvironmentId: Effect.succeed(EnvironmentId.make("env-1")),
        }),
        Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({
          resolve: () =>
            Effect.succeed(input.identity === undefined ? webIdentity : input.identity),
        }),
      ),
    ),
    Layer.build,
    Effect.map((context) => Context.get(context, Memory.Memory)),
  );
  return { build, proposals, merged, store, reads };
};

it.effect(
  "reads the team file, the project's file by its remote, and only the viewer's own file",
  () =>
    Effect.gen(function* () {
      const memory = yield* makeMemory({ catalog: catalog() }).build;
      const view = yield* memory.read(PROJECT_ID);
      expect(view.documents).toEqual([
        {
          scope: "team",
          file: "memory/team.md",
          label: null,
          text: FILES["memory/team.md"],
          unavailable: null,
        },
        {
          scope: "project",
          file: "memory/projects/web.md",
          label: "Web app",
          text: FILES["memory/projects/web.md"],
          unavailable: null,
        },
        {
          scope: "personal",
          file: "memory/people/alice.md",
          label: "Alice",
          text: FILES["memory/people/alice.md"],
          unavailable: null,
        },
        {
          scope: "personal-project",
          file: "memory/projects/web/people/alice.md",
          label: "Alice",
          text: "",
          unavailable: null,
        },
      ]);
      const block = yield* memory.instructions(PROJECT_ID, THREAD_ID);
      expect(block).toBe(view.block);
      expect(block).toContain("call memory_propose");
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
    const signedOut = yield* makeMemory({
      catalog: catalog({ viewer: { login: null, problem: "The GitHub CLI is not signed in." } }),
      identity: null,
    }).build;
    const view = yield* signedOut.read(PROJECT_ID);
    expect(view.documents.map((document) => [document.file, document.unavailable])).toEqual([
      ["memory/team.md", null],
      [null, "This project is not in the team catalog."],
      [null, "The GitHub CLI is not signed in."],
      [null, "The GitHub CLI is not signed in."],
    ]);
    expect(view.block).toContain("Prefer small pull requests");
    expect(view.block).not.toContain("Keep replies short");

    const none = yield* makeMemory({ catalog: catalog({ source: null }) }).build;
    expect(yield* none.read(PROJECT_ID)).toMatchObject({ documents: [], block: null });
    expect(yield* none.instructions(PROJECT_ID, THREAD_ID)).toBeUndefined();
  }).pipe(Effect.scoped),
);

it.effect("names a project's Linear board and the thread's link, even without memory files", () =>
  Effect.gen(function* () {
    const boardCatalog = (
      fields: Partial<TeamCatalogSnapshot> = {},
      linear: TeamCatalogLinear = { team: "ENG" },
    ) => {
      const base = catalog(fields);
      const entry = base.projects[0]!;
      return { ...base, projects: [{ ...entry, project: { ...entry.project, linear } }] };
    };
    const threadLink =
      "<board>\nThis project's board is the ENG team in Linear; its tasks are Linear issues. Use it for every task you read, file or update, unless the user names another board.\nUse board_list to see its open tasks, board_add to file a task and board_update to change one";

    const memory = yield* makeMemory({ catalog: boardCatalog() }).build;
    const view = yield* memory.read(PROJECT_ID);
    const block = yield* memory.instructions(PROJECT_ID, THREAD_ID);
    expect(block).toContain(`${view.block}\n\n${threadLink}`);
    expect(block).toContain("need none.\nThis thread's link is t3-thread://v2/env-1/thread-1.");
    expect(view.block).not.toContain("<board>");

    const empty = yield* makeMemory({
      catalog: boardCatalog(),
      readFile: () => Effect.succeed(null),
    }).build;
    const emptyBlock = yield* empty.instructions(PROJECT_ID, THREAD_ID);
    expect(emptyBlock).toContain("Nothing is saved yet.");
    expect(emptyBlock).toContain(`</memory>\n\n${threadLink}`);

    const unmatched = yield* makeMemory({ catalog: boardCatalog(), identity: null }).build;
    expect(yield* unmatched.instructions(PROJECT_ID, THREAD_ID)).not.toContain("<board>");

    const narrowed = yield* makeMemory({
      catalog: boardCatalog({}, { team: "PLAT", project: "Platform" }),
    }).build;
    expect(yield* narrowed.instructions(PROJECT_ID, THREAD_ID)).toContain(
      `This project's board is the Linear project "Platform" in the PLAT team;`,
    );
  }).pipe(Effect.scoped),
);

it.effect("proposes the edited file, and refuses an unchanged one or a scope without a file", () =>
  Effect.gen(function* () {
    const fixture = makeMemory({ catalog: catalog(), identity: null });
    const memory = yield* fixture.build;
    const propose = (scope: "team" | "project" | "personal", text: string) =>
      memory.propose({ projectId: PROJECT_ID, scope, baseRevision: "rev-1", text });

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
            file: "memory/people/alice.md",
            text: "- Keep replies short.\n- Say what changed.\n",
          },
        ],
        title: "Update personal memory for Alice",
        body: expect.stringContaining("memory/people/alice.md"),
        branchStem: "memory/personal-alice",
      },
    ]);

    // After a GitHub CLI account switch, a personal edit goes to the signed-in person's file.
    const switched = makeMemory({ catalog: catalog(), liveLogin: "Bob" });
    const bob = yield* switched.build;
    yield* bob.propose({
      projectId: PROJECT_ID,
      scope: "personal",
      baseRevision: "rev-1",
      text: "- Bob's new rule.",
    });
    expect(switched.proposals.map((proposal) => proposal.files)).toEqual([
      [{ file: "memory/people/bob.md", text: "- Bob's new rule.\n" }],
    ]);
    const signedOut = yield* makeMemory({ catalog: catalog(), liveLogin: null }).build;
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
    const memory = yield* makeMemory({ catalog: catalog(), refreshed }).build;
    yield* TestClock.adjust("11 minutes");
    expect(yield* memory.instructions(PROJECT_ID, THREAD_ID)).toContain(
      "Prefer small pull requests",
    );
    yield* Deferred.await(refreshed);

    const broken = yield* makeMemory({
      catalog: catalog(),
      readFile: () => Effect.die("disk gone"),
    }).build;
    expect(yield* broken.instructions(PROJECT_ID, THREAD_ID)).toBeUndefined();

    const cancelled = yield* makeMemory({
      catalog: catalog(),
      readFile: () => Effect.interrupt,
    }).build;
    const exit = yield* Effect.exit(cancelled.instructions(PROJECT_ID, THREAD_ID));
    expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
  }).pipe(Effect.scoped),
);

const agentProposal = (text: string, threadId = THREAD_ID) => ({
  projectId: PROJECT_ID,
  threadId,
  threadTitle: "Fix the build",
  text,
  reason: "The user said it twice.",
});

it.effect(
  "records an agent's proposal once per thread and text, and keeps it after a restart",
  () =>
    Effect.gen(function* () {
      const fixture = makeMemory({ catalog: catalog() });
      const memory = yield* fixture.build;
      const first = yield* memory.proposeFromAgent(agentProposal("  Use tabs.  "));
      expect(first).toMatchObject({
        text: "Use tabs.",
        threadTitle: "Fix the build",
        decision: null,
      });
      expect((yield* memory.proposeFromAgent(agentProposal("Use tabs."))).id).toBe(first.id);
      expect((yield* memory.read(PROJECT_ID)).proposals).toEqual([first]);
      expect(fixture.store.saved).toEqual([
        { ...first, projectId: PROJECT_ID, decidedBySession: null },
      ]);

      const restarted = yield* makeMemory({ catalog: catalog(), stored: fixture.store.saved })
        .build;
      expect((yield* restarted.read(PROJECT_ID)).proposals).toEqual([first]);

      const outside = yield* makeMemory({ catalog: catalog(), identity: null }).build;
      expect(
        (yield* Effect.flip(outside.proposeFromAgent(agentProposal("Use tabs.")))).detail,
      ).toBe("This project is not in the team catalog. There is nowhere to save memory for it.");
    }).pipe(Effect.scoped),
);

it.effect("accepting adds the edited line to the chosen file and merges at once", () =>
  Effect.gen(function* () {
    const fixture = makeMemory({ catalog: catalog() });
    const memory = yield* fixture.build;
    const mine = yield* memory.proposeFromAgent(agentProposal("Use tabs."));
    const accepted = yield* memory.decide(
      { projectId: PROJECT_ID, proposalId: mine.id, choice: "me", text: "Use tabs in this repo." },
      "session-1",
    );
    expect(accepted.decision).toMatchObject({
      choice: "me",
      text: "Use tabs in this repo.",
      file: "memory/projects/web/people/alice.md",
      pullRequestUrl: "https://github.com/acme/home/pull/1",
      merged: true,
      problem: null,
    });
    expect(fixture.store.saved[0]?.decidedBySession).toBe("session-1");
    expect(
      (yield* Effect.flip(
        memory.decide(
          { projectId: PROJECT_ID, proposalId: mine.id, choice: "team", text: "Use tabs." },
          "session-1",
        ),
      )).detail,
    ).toBe("This proposal was already answered.");

    const team = yield* memory.proposeFromAgent(agentProposal("Tests need Node 24."));
    yield* memory.decide(
      { projectId: PROJECT_ID, proposalId: team.id, choice: "team", text: "Tests need Node 24." },
      "session-1",
    );
    const rejected = yield* memory.proposeFromAgent(agentProposal("Always use drafts."));
    const decision = yield* memory.decide(
      { projectId: PROJECT_ID, proposalId: rejected.id, choice: "reject", text: "Ignored." },
      "session-2",
    );
    expect(decision.decision).toMatchObject({ choice: "reject", text: null, file: null });

    expect(fixture.proposals.map((proposal) => proposal.files)).toEqual([
      [{ file: "memory/projects/web/people/alice.md", text: "- Use tabs in this repo.\n" }],
      [
        {
          file: "memory/projects/web.md",
          text: "- Run the web tests before pushing.\n- Tests need Node 24.\n",
        },
      ],
    ]);
    expect(fixture.merged).toHaveLength(2);
  }).pipe(Effect.scoped),
);

it.effect("a refused merge says why, and a failed push leaves the proposal unanswered", () =>
  Effect.gen(function* () {
    const blocked = yield* makeMemory({ catalog: catalog(), mergeFails: "Review required." }).build;
    const proposal = yield* blocked.proposeFromAgent(agentProposal("Use tabs."));
    const decided = yield* blocked.decide(
      { projectId: PROJECT_ID, proposalId: proposal.id, choice: "team", text: "Use tabs." },
      "session-1",
    );
    expect(decided.decision).toMatchObject({ merged: false, problem: "Review required." });

    const offline = yield* makeMemory({ catalog: catalog(), pushFails: "Could not push." }).build;
    const pending = yield* offline.proposeFromAgent(agentProposal("Use tabs."));
    const failure = yield* Effect.flip(
      offline.decide(
        { projectId: PROJECT_ID, proposalId: pending.id, choice: "me", text: "Use tabs." },
        "session-1",
      ),
    );
    expect(failure.detail).toBe("Could not push.");
    expect((yield* offline.read(PROJECT_ID)).proposals[0]?.decision).toBeNull();
  }).pipe(Effect.scoped),
);

it.effect("a proposal made during a slow save is not lost when that save lands", () =>
  Effect.gen(function* () {
    const slowFirstSave = {
      started: yield* Deferred.make<void>(),
      release: yield* Deferred.make<void>(),
    };
    const fixture = makeMemory({ catalog: catalog(), slowFirstSave });
    const memory = yield* fixture.build;
    const first = yield* Effect.forkChild(memory.proposeFromAgent(agentProposal("Use tabs.")));
    yield* Deferred.await(slowFirstSave.started);
    const second = yield* Effect.forkChild(memory.proposeFromAgent(agentProposal("Prefer pnpm.")));
    // Lets the second call run as far as it can before the first save lands.
    yield* Effect.yieldNow;
    yield* Deferred.succeed(slowFirstSave.release, undefined);
    yield* Fiber.join(first);
    yield* Fiber.join(second);
    expect(fixture.store.saved.map((saved) => saved.text)).toEqual(["Use tabs.", "Prefer pnpm."]);
  }).pipe(Effect.scoped),
);

it.effect(
  "keeps voice agent memories out of the block, and reads only the viewer's own active ones",
  () =>
    Effect.gen(function* () {
      const fixture = makeMemory({ catalog: catalog() });
      const memory = yield* fixture.build;
      const block = yield* memory.instructions(PROJECT_ID, THREAD_ID);
      expect(block).not.toContain("one sentence per agent");
      // A turn of any other agent does not even read the file.
      expect(fixture.reads.filter((file) => file.includes("voice-agent"))).toEqual([]);

      const view = yield* memory.read(PROJECT_ID);
      const without = yield* makeMemory({
        catalog: catalog(),
        readFile: (file) =>
          Effect.succeed(file.includes("voice-agent") ? null : (FILES[file] ?? null)),
      }).build;
      const plain = yield* without.read(PROJECT_ID);
      expect(view.block).toBe(block);
      expect({ block: view.block, documents: view.documents }).toEqual({
        block: plain.block,
        documents: plain.documents,
      });
      expect(plain.voiceAgent).toEqual({
        file: VOICE_FILE,
        unavailable: null,
        active: [],
        earlier: [],
      });
      expect(view.voiceAgent).toEqual({
        file: VOICE_FILE,
        unavailable: null,
        active: [{ text: "Keep updates to one sentence per agent.", savedOn: "2026-03-09" }],
        earlier: [
          {
            text: "Give a paragraph per agent.",
            savedOn: "2026-03-02",
            replacedOn: "2026-03-09",
            replacedBy: "Keep updates to one sentence per agent.",
          },
        ],
      });

      const instructions = yield* memory.voiceAgentInstructions();
      expect(instructions).toContain("\n- Keep updates to one sentence per agent.\n");
      expect(instructions).not.toContain("Give a paragraph per agent");
      expect(instructions).not.toContain("Prefer small pull requests");
      expect(yield* memory.voiceAgentEarlier()).toEqual(view.voiceAgent.earlier);
      expect(new Set(fixture.reads.filter((file) => file.includes("voice-agent")))).toEqual(
        new Set([VOICE_FILE]),
      );

      const signedOut = yield* makeMemory({
        catalog: catalog({ viewer: { login: null, problem: "The GitHub CLI is not signed in." } }),
      }).build;
      expect(yield* signedOut.voiceAgentInstructions()).toBeUndefined();
      expect((yield* signedOut.read(PROJECT_ID)).voiceAgent).toMatchObject({
        file: null,
        unavailable: "The GitHub CLI is not signed in.",
      });
      const none = yield* makeMemory({ catalog: catalog({ source: null }) }).build;
      expect(yield* none.voiceAgentInstructions()).toBeUndefined();
      expect(yield* none.voiceAgentEarlier()).toEqual([]);
      const broken = yield* makeMemory({
        catalog: catalog(),
        readFile: () => Effect.die("disk gone"),
      }).build;
      expect(yield* broken.voiceAgentInstructions()).toBeUndefined();
      expect(yield* broken.voiceAgentEarlier()).toEqual([]);
    }).pipe(Effect.scoped),
);

it.effect("accepting a voice agent memory puts it in place of the one it replaces", () =>
  Effect.gen(function* () {
    const voice = (text: string, replaces?: string) => ({
      ...agentProposal(text),
      category: "voice-agent-memories" as const,
      replaces,
    });
    // The file is the person's own, so the thread's project need not be in the catalog.
    const fixture = makeMemory({ catalog: catalog(), identity: null });
    const memory = yield* fixture.build;
    expect(
      (yield* Effect.flip(
        memory.proposeFromAgent(voice("Give two sentences per agent.", "Keep it short.")),
      )).detail,
    ).toBe(
      'No voice agent memory has the text given as replaces. Give the exact text of one of the active ones: "Keep updates to one sentence per agent.". Leave replaces out for a new subject.',
    );
    expect(
      (yield* Effect.flip(
        memory.proposeFromAgent({ ...agentProposal("Use tabs."), replaces: "Use spaces." }),
      )).detail,
    ).toContain("Only a voice agent memory replaces another one.");

    const proposal = yield* memory.proposeFromAgent(
      voice("Give two sentences per agent.", " Keep updates to one sentence per agent. "),
    );
    expect(proposal).toMatchObject({
      category: "voice-agent-memories",
      replaces: "Keep updates to one sentence per agent.",
      decision: null,
    });
    const decide = (choice: "me" | "team", proposalId = proposal.id) =>
      memory.decide(
        { projectId: PROJECT_ID, proposalId, choice, text: "Give two sentences per agent." },
        "session-1",
      );
    expect((yield* Effect.flip(decide("team"))).detail).toBe(
      "A voice agent memory is yours alone: accept it for yourself or reject it.",
    );
    expect((yield* decide("me")).decision).toMatchObject({
      choice: "me",
      text: "Give two sentences per agent.",
      file: VOICE_FILE,
      merged: true,
    });
    expect(fixture.proposals).toEqual([
      {
        baseRevision: "rev-1",
        files: [
          {
            file: VOICE_FILE,
            text: [
              "# Voice agent memories",
              "",
              "- Give two sentences per agent. (saved 1970-01-01)",
              "",
              "## Earlier",
              "",
              "- Keep updates to one sentence per agent. (saved 2026-03-09, replaced 1970-01-01 by: Give two sentences per agent.)",
              "- Give a paragraph per agent. (saved 2026-03-02, replaced 2026-03-09 by: Keep updates to one sentence per agent.)",
              "",
            ].join("\n"),
          },
        ],
        title: "Remember for the voice agent: Give two sentences per agent.",
        body: expect.stringContaining(
          "It replaces this memory, which moves to the file's log:\n\n> Keep updates to one sentence per agent.",
        ),
        branchStem: "memory/voice-agent-alice",
      },
    ]);
    expect(fixture.merged).toHaveLength(1);

    const repeat = yield* memory.proposeFromAgent(voice("Keep updates to one sentence per agent."));
    expect(
      (yield* Effect.flip(
        memory.decide(
          {
            projectId: PROJECT_ID,
            proposalId: repeat.id,
            choice: "me",
            text: "Keep updates to one sentence per agent.",
          },
          "session-1",
        ),
      )).detail,
    ).toBe("Nothing to save: this voice agent memory is already active.");

    // After a GitHub CLI account switch, the memory goes to the signed-in person's file.
    const switched = makeMemory({ catalog: catalog(), liveLogin: "Bob" });
    const bob = yield* switched.build;
    const added = yield* bob.proposeFromAgent(voice("Skip finished agents."));
    yield* bob.decide(
      { projectId: PROJECT_ID, proposalId: added.id, choice: "me", text: "Skip finished agents." },
      "session-1",
    );
    expect(switched.proposals.map((files) => files.files)).toEqual([
      [
        {
          file: "memory/people/bob/voice-agent-memories.md",
          text: "# Voice agent memories\n\n- Bob wants every detail.\n- Skip finished agents. (saved 1970-01-01)\n",
        },
      ],
    ]);
  }).pipe(Effect.scoped),
);
