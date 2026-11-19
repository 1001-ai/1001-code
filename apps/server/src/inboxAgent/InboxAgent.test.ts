import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  type ApplicationStoredEvent,
  INBOX_AGENT_DEFAULT_MODEL,
  INBOX_AGENT_THREAD_TITLE,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadShell,
  ProjectId,
  ProviderInstanceId,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import { liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as InboxAgent from "./InboxAgent.ts";
import { isInboxThread } from "./inboxAgentThreads.ts";

const PROJECT = ProjectId.make("project-acme");
const OTHER_PROJECT = ProjectId.make("project-other");
const SCRATCH = ProjectId.make("project-scratch");

const claude = (fields: Partial<ServerProvider> = {}) =>
  ({
    instanceId: ProviderInstanceId.make("claudeAgent"),
    driver: "claudeAgent",
    enabled: true,
    installed: true,
    status: "ready",
    auth: { status: "authenticated" },
    ...fields,
  }) as unknown as ServerProvider;
const signedOut = claude({ auth: { status: "unauthenticated" } as never });

type Create = Extract<OrchestrationV2ServerCommand, { readonly type: "thread.create" }>;
type RuntimeModeSet = Extract<
  OrchestrationV2ServerCommand,
  { readonly type: "thread.runtime-mode.set" }
>;
type Shell = OrchestrationV2ThreadShell & { deletedAt?: unknown };

const projectCreated = (projectId: ProjectId) =>
  ({ type: "project.created", aggregateId: projectId, payload: { projectId } }) as never;

/** The Inbox over fakes: projects, providers and thread shells kept in memory. */
const withInbox = <A, E>(
  options: {
    readonly watch?: boolean;
    readonly stateDir?: string;
    readonly providers?: ReadonlyArray<ServerProvider>;
    /** Whether Claude is on for the project at the start. */
    readonly enabled?: boolean;
  },
  test: (fixture: {
    readonly service: InboxAgent.InboxAgent["Service"];
    readonly created: Array<Create>;
    readonly runtimeModeSets: Array<RuntimeModeSet>;
    /** Each create, as the watcher's milestone. */
    readonly creates: Queue.Queue<Create>;
    readonly shells: Map<ThreadId, Shell>;
    readonly projects: Array<ProjectId>;
    readonly projectEvents: Queue.Queue<ApplicationStoredEvent>;
    readonly providerChanges: Queue.Queue<ReadonlyArray<ServerProvider>>;
    readonly settingsChanges: Queue.Queue<void>;
    readonly setProviders: (providers: ReadonlyArray<ServerProvider>) => void;
    readonly setEnabled: (enabled: boolean) => void;
    readonly stateDir: string;
  }) => Effect.Effect<A, E>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const stateDir = options.stateDir ?? (yield* fs.makeTempDirectoryScoped());
      const shells = new Map<ThreadId, Shell>();
      const created: Array<Create> = [];
      const runtimeModeSets: Array<RuntimeModeSet> = [];
      const creates = yield* Queue.unbounded<Create>();
      const projects: Array<ProjectId> = [PROJECT];
      const projectEvents = yield* Queue.unbounded<ApplicationStoredEvent>();
      const providerChanges = yield* Queue.unbounded<ReadonlyArray<ServerProvider>>();
      const settingsChanges = yield* Queue.unbounded<void>();
      let providers: ReadonlyArray<ServerProvider> = options.providers ?? [claude()];
      let enabled = options.enabled ?? true;
      const live = (archived: boolean, projectId: ProjectId | undefined) =>
        [...shells.values()].filter(
          (shell) =>
            shell.deletedAt == null &&
            (shell.archivedAt !== null) === archived &&
            (projectId === undefined || shell.projectId === projectId),
        );
      const dependencies = Layer.mergeAll(
        Layer.succeed(ServerConfig.ServerConfig, {
          stateDir,
        } as ServerConfig.ServerConfig["Service"]),
        Layer.mock(ProviderRegistry.ProviderRegistry)({
          getProviders: Effect.sync(() => providers),
          // A change is what getProviders answers from then on, as in the real registry.
          streamChanges: Stream.fromQueue(providerChanges).pipe(
            Stream.tap((next) =>
              Effect.sync(() => {
                providers = next;
              }),
            ),
          ),
        }),
        Layer.mock(ServerSettings.ServerSettingsService)({
          streamChanges: Stream.fromQueue(settingsChanges).pipe(Stream.map(() => ({}) as never)),
        }),
        Layer.mock(ProjectStore.ProjectStoreV2)({
          list: () => Effect.sync(() => projects.map((projectId) => ({ projectId }) as never)),
        }),
        Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
          namedProjectsRoot: "/projects",
          isScratchProject: (projectId) => Effect.succeed(projectId === SCRATCH),
        }),
        Layer.mock(OrchestrationEventStore.OrchestrationEventStore)({
          latestApplicationSequence: Effect.succeed(0),
          streamApplicationEvents: () => Stream.fromQueue(projectEvents),
        }),
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadShell: (threadId) => Effect.sync(() => shells.get(threadId) ?? null),
          getShellSnapshot: (snapshot) =>
            Effect.sync(
              () =>
                ({
                  threads: live(snapshot?.location === "archive", snapshot?.projectId),
                }) as never,
            ),
          isProviderInstanceEnabledForProject: () => Effect.sync(() => enabled),
          dispatch: (command) =>
            Effect.gen(function* () {
              if (command.type === "thread.runtime-mode.set") {
                runtimeModeSets.push(command);
                // As the orchestrator refuses a change that would end background work.
                if (command.threadId === "inbox-refused") return yield* Effect.die("busy");
                const shell = shells.get(command.threadId)!;
                shells.set(command.threadId, { ...shell, runtimeMode: command.runtimeMode });
                return undefined as never;
              }
              if (command.type !== "thread.create") throw new Error(command.type);
              // Two triggers racing would both get here without the service's lock.
              yield* Effect.yieldNow;
              created.push(command);
              shells.set(command.threadId, {
                ...liveThreadShell(command.threadId),
                projectId: command.projectId,
                title: command.title,
                createdBy: command.createdBy,
                creationSource: command.creationSource,
              } as Shell);
              yield* Queue.offer(creates, command);
              return undefined as never;
            }),
        }),
        NodeServices.layer,
      );
      // Built in this test's scope, so the watcher runs until the test ends.
      const context = yield* Layer.build(
        (options.watch === true ? InboxAgent.layer : InboxAgent.layerService).pipe(
          Layer.provide(dependencies),
        ),
      );
      const service = Context.get(context, InboxAgent.InboxAgent);
      return yield* test({
        service,
        created,
        runtimeModeSets,
        creates,
        shells,
        projects,
        projectEvents,
        providerChanges,
        settingsChanges,
        setProviders: (next) => {
          providers = next;
        },
        setEnabled: (next) => {
          enabled = next;
        },
        stateDir,
      });
    }),
  ).pipe(Effect.provide(NodeServices.layer));

it.effect("makes a project's Inbox once: an ordinary Claude thread named Inbox, no message", () =>
  withInbox({}, ({ service, created, shells }) =>
    Effect.gen(function* () {
      const first = yield* service.ensure(PROJECT);
      expect(first).toMatchObject({ status: "ready", created: true });
      expect(created).toHaveLength(1);
      expect(created[0]).toMatchObject({
        type: "thread.create",
        projectId: PROJECT,
        title: INBOX_AGENT_THREAD_TITLE,
        modelSelection: { instanceId: "claudeAgent", model: INBOX_AGENT_DEFAULT_MODEL },
        runtimeMode: "full-access",
        worktreePath: null,
        createdBy: "system",
        creationSource: "server",
      });
      expect(created[0]).not.toHaveProperty("initialMessage");
      const threadId = first.status === "ready" ? first.threadId : null;
      expect(shells.get(threadId!)?.lineage.sideChat).toBeUndefined();
      expect(service.isInboxThread(threadId!)).toBe(true);

      expect(yield* service.ensure(PROJECT)).toEqual({ status: "ready", threadId, created: false });
      expect(created).toHaveLength(1);
      yield* service.ensure(OTHER_PROJECT);
      expect(created.map((command) => command.projectId)).toEqual([PROJECT, OTHER_PROJECT]);
    }),
  ),
);

it.effect("makes one thread when two triggers race", () =>
  withInbox({}, ({ service, created }) =>
    Effect.gen(function* () {
      const [left, right] = yield* Effect.all([service.ensure(PROJECT), service.ensure(PROJECT)], {
        concurrency: 2,
      });
      expect(created).toHaveLength(1);
      expect(left.status === "ready" && left.threadId).toBe(
        right.status === "ready" && right.threadId,
      );
    }),
  ),
);

it.effect("makes a new Inbox after the recorded one is deleted", () =>
  withInbox({}, ({ service, created, shells }) =>
    Effect.gen(function* () {
      const first = yield* service.ensure(PROJECT);
      const firstId = first.status === "ready" ? first.threadId : null;
      shells.set(firstId!, { ...shells.get(firstId!)!, deletedAt: DateTime.makeUnsafe(0) });
      const second = yield* service.ensure(PROJECT);
      expect(created).toHaveLength(2);
      const secondId = second.status === "ready" ? second.threadId : null;
      expect(secondId).not.toBe(firstId);
      expect(service.isInboxThread(secondId!)).toBe(true);
      expect(service.isInboxThread(firstId!)).toBe(false);
      // A recorded thread that no longer looks like an Inbox (an earlier build's hidden side chat).
      const secondShell = shells.get(secondId!)!;
      shells.set(secondId!, {
        ...secondShell,
        lineage: { ...secondShell.lineage, sideChat: true },
      });
      yield* service.ensure(PROJECT);
      expect(created).toHaveLength(3);
      expect(service.isInboxThread(secondId!)).toBe(false);
    }),
  ),
);

it.effect("takes the oldest Inbox the server made before when nothing is recorded", () =>
  withInbox({}, ({ service, created, shells }) =>
    Effect.gen(function* () {
      const server = (id: string, createdAt: number, fields: Partial<Shell> = {}) =>
        shells.set(ThreadId.make(id), {
          ...liveThreadShell(ThreadId.make(id)),
          projectId: PROJECT,
          title: "Inbox",
          createdBy: "system",
          creationSource: "server",
          createdAt: DateTime.makeUnsafe(createdAt),
          ...fields,
        } as Shell);
      server("inbox-newer", 2_000);
      server("inbox-older", 1_000, { archivedAt: DateTime.makeUnsafe(0) });
      // A thread a user named Inbox is never taken for it.
      server("user-inbox", 0, { createdBy: "user", creationSource: "web" });
      expect(yield* service.ensure(PROJECT)).toMatchObject({
        threadId: "inbox-older",
        created: false,
      });
      expect(created).toEqual([]);
    }),
  ),
);

it.effect("raises an Inbox an older build made to full-access, and leaves a full-access one", () =>
  withInbox({}, ({ service, created, runtimeModeSets, shells }) =>
    Effect.gen(function* () {
      const server = (id: string, fields: Partial<Shell>) =>
        shells.set(ThreadId.make(id), {
          ...liveThreadShell(ThreadId.make(id), { runtimeMode: "approval-required" }),
          projectId: PROJECT,
          title: "Inbox",
          createdBy: "system",
          creationSource: "server",
          activeRunId: null,
          ...fields,
        } as Shell);
      // Found, not recorded.
      server("inbox-old", { updatedAt: DateTime.makeUnsafe(5_000) });
      expect(yield* service.ensure(PROJECT)).toMatchObject({
        threadId: "inbox-old",
        created: false,
      });
      expect(created).toEqual([]);
      expect(runtimeModeSets).toEqual([
        {
          type: "thread.runtime-mode.set",
          commandId: "inbox-agent:runtime-mode:inbox-old:5000",
          threadId: "inbox-old",
          runtimeMode: "full-access",
        },
      ]);
      expect(shells.get(ThreadId.make("inbox-old"))?.runtimeMode).toBe("full-access");
      // Recorded and already full-access: nothing is sent.
      yield* service.ensure(PROJECT);
      expect(runtimeModeSets).toHaveLength(1);

      // Recorded and lowered again: raised again.
      server("inbox-old", { updatedAt: DateTime.makeUnsafe(6_000) });
      yield* service.ensure(PROJECT);
      expect(runtimeModeSets.map((command) => command.commandId)).toEqual([
        "inbox-agent:runtime-mode:inbox-old:5000",
        "inbox-agent:runtime-mode:inbox-old:6000",
      ]);
    }),
  ),
);

it.effect("returns the Inbox when raising its runtime mode fails", () =>
  withInbox({}, ({ service, created, runtimeModeSets, shells }) =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("inbox-refused");
      shells.set(threadId, {
        ...liveThreadShell(threadId, { runtimeMode: "approval-required", activeRunId: null }),
        projectId: PROJECT,
        title: "Inbox",
        createdBy: "system",
        creationSource: "server",
      } as Shell);
      expect(yield* service.ensure(PROJECT)).toEqual({ status: "ready", threadId, created: false });
      expect(runtimeModeSets).toHaveLength(1);
      expect(created).toEqual([]);
      expect(service.isInboxThread(threadId)).toBe(true);
    }),
  ),
);

it.effect("leaves a running Inbox's runtime mode for a later ensure", () =>
  withInbox({}, ({ service, runtimeModeSets, shells }) =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("inbox-running");
      shells.set(threadId, {
        ...liveThreadShell(threadId, { runtimeMode: "approval-required" }),
        projectId: PROJECT,
        title: "Inbox",
        createdBy: "system",
        creationSource: "server",
      } as Shell);
      expect(yield* service.ensure(PROJECT)).toMatchObject({ threadId, created: false });
      expect(runtimeModeSets).toEqual([]);
      shells.set(threadId, { ...shells.get(threadId)!, activeRunId: null });
      yield* service.ensure(PROJECT);
      expect(runtimeModeSets.map((command) => command.threadId)).toEqual([threadId]);
    }),
  ),
);

it.effect("records the Inbox in the state file, and a restart knows it from there", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const stateDir = yield* fs.makeTempDirectoryScoped();
    const threadId = yield* withInbox({ stateDir }, ({ service }) =>
      service
        .ensure(PROJECT)
        .pipe(Effect.map((result) => (result as { threadId: ThreadId }).threadId)),
    );
    const state = JSON.parse(
      yield* fs.readFileString(path.join(stateDir, "inbox-agent", "state.json")),
    );
    expect(state).toEqual({ version: 1, projects: { [PROJECT]: threadId } });
    yield* withInbox({ stateDir }, ({ service }) =>
      Effect.sync(() => {
        expect(service.isInboxThread(threadId)).toBe(true);
        expect(isInboxThread(ThreadId.make("chat"))).toBe(false);
      }),
    );
    // Another state directory knows nothing of it.
    yield* withInbox({}, ({ service }) =>
      Effect.sync(() => expect(service.isInboxThread(threadId)).toBe(false)),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("skips a project without a usable Claude, and retries when providers change", () =>
  withInbox({}, ({ service, created, setProviders, setEnabled }) =>
    Effect.gen(function* () {
      setProviders([signedOut]);
      expect(yield* service.ensure(PROJECT)).toEqual({ status: "waiting-for-claude" });
      // Still no Claude: nothing is retried.
      yield* service.retryWaiting([signedOut]);
      expect(created).toEqual([]);

      setProviders([claude()]);
      setEnabled(false);
      expect(yield* service.ensure(PROJECT)).toEqual({ status: "waiting-for-claude" });
      setEnabled(true);
      yield* service.retryWaiting([claude()]);
      expect(created.map((command) => command.projectId)).toEqual([PROJECT]);
      // Nothing waits any more, so a later change makes nothing.
      yield* service.retryWaiting([claude()]);
      expect(created).toHaveLength(1);
    }),
  ),
);

it.effect("leaves the No project folder without an Inbox", () =>
  withInbox({}, ({ service, created }) =>
    Effect.gen(function* () {
      expect(yield* service.ensure(SCRATCH)).toEqual({ status: "skipped" });
      expect(created).toEqual([]);
    }),
  ),
);

it.effect("gives every project an Inbox at startup, and a new project its own", () =>
  withInbox({ watch: true }, ({ creates, projectEvents, projects }) =>
    Effect.gen(function* () {
      expect((yield* Queue.take(creates)).projectId).toBe(PROJECT);
      projects.push(OTHER_PROJECT);
      yield* Queue.offer(projectEvents, projectCreated(OTHER_PROJECT));
      expect((yield* Queue.take(creates)).projectId).toBe(OTHER_PROJECT);
    }),
  ),
);

it.effect("makes a waiting project's Inbox once Claude becomes ready", () =>
  withInbox({ watch: true, providers: [signedOut] }, ({ creates, providerChanges }) =>
    Effect.gen(function* () {
      // The watcher reads provider changes only after the startup pass, which made nothing.
      yield* Queue.offer(providerChanges, [claude()]);
      expect((yield* Queue.take(creates)).projectId).toBe(PROJECT);
    }),
  ),
);

it.effect("makes a waiting project's Inbox once Claude is turned on in its settings", () =>
  withInbox({ watch: true, enabled: false }, ({ creates, settingsChanges, setEnabled }) =>
    Effect.gen(function* () {
      setEnabled(true);
      yield* Queue.offer(settingsChanges, undefined);
      expect((yield* Queue.take(creates)).projectId).toBe(PROJECT);
    }),
  ),
);
