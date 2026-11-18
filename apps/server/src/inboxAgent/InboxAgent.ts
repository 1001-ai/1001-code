import {
  CommandId,
  INBOX_AGENT_DEFAULT_MODEL,
  INBOX_AGENT_THREAD_TITLE,
  type ApplicationProjectCreatedEvent,
  type ApplicationStoredEvent,
  type OrchestrationV2ThreadShell,
  ProjectId,
  type ServerProvider,
  ThreadId,
  isInboxThreadShell,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import { lockedAgentProvider } from "../lockedAgents/lockedAgentProvider.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import { forkParked } from "../serverActivation.ts";
import {
  inboxThreadOf,
  inboxThreads,
  isInboxThread,
  recordInboxThread,
  replaceInboxThreads,
} from "./inboxAgentThreads.ts";

/** What ensuring a project's Inbox did. */
export type InboxAgentEnsureResult =
  | { readonly status: "ready"; readonly threadId: ThreadId; readonly created: boolean }
  /** No usable Claude here, or Claude is off for the project: retried when providers change. */
  | { readonly status: "waiting-for-claude" }
  | { readonly status: "skipped" };

export class InboxAgent extends Context.Service<
  InboxAgent,
  {
    readonly isInboxThread: (threadId: ThreadId) => boolean;
    /**
     * Makes sure the project has exactly one Inbox thread: the one the state file records while
     * it is not deleted, else the oldest Inbox-looking thread the server made, else a new one.
     * Every trigger (startup, a new project, providers changing) goes through here.
     */
    readonly ensure: (projectId: ProjectId) => Effect.Effect<InboxAgentEnsureResult>;
    /** `ensure` for every project that is not deleted. */
    readonly ensureAll: Effect.Effect<void>;
    /** `ensureAll` again when a project waits for Claude and Claude is now ready. */
    readonly retryWaiting: (providers: ReadonlyArray<ServerProvider>) => Effect.Effect<void>;
  }
>()("t3/inboxAgent/InboxAgent") {}

const StateFile = Schema.fromJsonString(
  Schema.Struct({
    version: Schema.Literal(1),
    /** Project id to its Inbox thread id. */
    projects: Schema.Record(ProjectId, ThreadId),
  }),
);
const decodeState = Schema.decodeUnknownOption(StateFile);
const encodeState = Schema.encodeSync(StateFile);

/** The oldest thread of a project that looks like its Inbox, as clients pick it. */
function oldestInboxShell(
  shells: ReadonlyArray<
    Pick<
      OrchestrationV2ThreadShell,
      "id" | "projectId" | "title" | "createdBy" | "creationSource" | "lineage" | "createdAt"
    >
  >,
  projectId: ProjectId,
): ThreadId | null {
  let found: (typeof shells)[number] | null = null;
  for (const shell of shells) {
    if (shell.projectId !== projectId || !isInboxThreadShell(shell)) continue;
    if (
      found === null ||
      DateTime.toEpochMillis(shell.createdAt) < DateTime.toEpochMillis(found.createdAt)
    ) {
      found = shell;
    }
  }
  return found?.id ?? null;
}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const registry = yield* ProviderRegistry.ProviderRegistry;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const managedFolders = yield* ManagedProjectFolders.ManagedProjectFolders;

  const statePath = path.join(config.stateDir, "inbox-agent", "state.json");
  const loaded = yield* fs.readFileString(statePath).pipe(
    Effect.map((text) => decodeState(text)),
    Effect.orElseSucceed(() => undefined),
  );
  replaceInboxThreads(
    new Map(
      loaded?._tag === "Some"
        ? (Object.entries(loaded.value.projects) as Array<[ProjectId, ThreadId]>)
        : [],
    ),
  );
  const writeState = fs.makeDirectory(path.dirname(statePath), { recursive: true }).pipe(
    Effect.andThen(
      Effect.suspend(() =>
        fs.writeFileString(
          statePath,
          encodeState({ version: 1, projects: Object.fromEntries(inboxThreads()) }),
          { mode: 0o600 },
        ),
      ),
    ),
    Effect.tapError((cause) => Effect.logWarning("The Inbox state file was not written.", cause)),
    Effect.ignore,
  );

  // One ensure at a time, so two triggers never make two threads for a project.
  const lock = yield* Semaphore.make(1);
  // Set when a project was skipped for want of Claude; a provider change then retries.
  let waitingForClaude = false;
  let created = 0;

  const liveThread = (threadId: ThreadId, projectId: ProjectId) =>
    threads
      .getThreadShell(threadId)
      .pipe(
        Effect.map(
          (shell) =>
            shell !== null &&
            shell.deletedAt == null &&
            shell.projectId === projectId &&
            isInboxThreadShell(shell),
        ),
      );

  const findExisting = (projectId: ProjectId) =>
    Effect.all(
      [
        threads.getShellSnapshot({ projectId }),
        threads.getShellSnapshot({ projectId, location: "archive" }),
      ],
      { concurrency: 2 },
    ).pipe(
      Effect.map(([active, archived]) =>
        oldestInboxShell([...active.threads, ...archived.threads], projectId),
      ),
    );

  const create = Effect.fn("InboxAgent.create")(function* (projectId: ProjectId) {
    const provider = lockedAgentProvider(yield* registry.getProviders);
    if (provider === undefined) return null;
    const enabled = yield* threads.isProviderInstanceEnabledForProject({
      projectId,
      instanceId: provider.instanceId,
    });
    if (!enabled) return null;
    // The time and a counter: a deleted thread's id stays taken, so a new Inbox never reuses it.
    created += 1;
    const threadId = ThreadId.make(
      `inbox-${projectId}-${(yield* Clock.currentTimeMillis).toString(36)}-${created}`,
    );
    yield* threads.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`inbox-agent:create:${threadId}`),
      threadId,
      projectId,
      title: INBOX_AGENT_THREAD_TITLE,
      modelSelection: { instanceId: provider.instanceId, model: INBOX_AGENT_DEFAULT_MODEL },
      // The lowest mode. The tool lock does not depend on it, but nothing should ask for more.
      runtimeMode: "approval-required",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "system",
      creationSource: "server",
    });
    return threadId;
  });

  const ensureUnlocked = Effect.fn("InboxAgent.ensure")(function* (projectId: ProjectId) {
    if (yield* managedFolders.isScratchProject(projectId)) return { status: "skipped" } as const;
    const recorded = inboxThreadOf(projectId);
    if (recorded !== undefined && (yield* liveThread(recorded, projectId))) {
      return { status: "ready", threadId: recorded, created: false } as const;
    }
    const existing = yield* findExisting(projectId);
    const threadId = existing ?? (yield* create(projectId));
    if (threadId === null) {
      waitingForClaude = true;
      return { status: "waiting-for-claude" } as const;
    }
    recordInboxThread(projectId, threadId);
    yield* writeState;
    return { status: "ready", threadId, created: existing === null } as const;
  });

  const ensure: InboxAgent["Service"]["ensure"] = (projectId) =>
    lock
      .withPermits(1)(ensureUnlocked(projectId))
      .pipe(
        Effect.tapCause((cause) =>
          Effect.logWarning("The project's Inbox could not be made.", { projectId, cause }),
        ),
        Effect.orElseSucceed(() => ({ status: "skipped" }) as const),
        Effect.catchDefect(() => Effect.succeed({ status: "skipped" } as const)),
      );

  const ensureAll: InboxAgent["Service"]["ensureAll"] = Effect.gen(function* () {
    waitingForClaude = false;
    const rows = yield* projects.list().pipe(Effect.orElseSucceed(() => []));
    yield* Effect.forEach(rows, (row) => ensure(row.projectId), { discard: true });
  }).pipe(Effect.withSpan("InboxAgent.ensureAll"));

  const retryWaiting: InboxAgent["Service"]["retryWaiting"] = (providers) =>
    waitingForClaude && lockedAgentProvider(providers) !== undefined ? ensureAll : Effect.void;

  return InboxAgent.of({ isInboxThread, ensure, ensureAll, retryWaiting });
});

/** The service alone, without its triggers. */
export const layerService = Layer.effect(InboxAgent, make);

const isProjectCreated = (event: ApplicationStoredEvent): event is ApplicationProjectCreatedEvent =>
  "type" in event && event.type === "project.created";

/**
 * The triggers. Kept beside `ensure` so changing when an Inbox is made (for example only when
 * someone names a thread "Inbox") touches only this function.
 */
const watch = Effect.gen(function* () {
  const inbox = yield* InboxAgent;
  const events = yield* OrchestrationEventStore.OrchestrationEventStore;
  const registry = yield* ProviderRegistry.ProviderRegistry;
  const afterSequence = yield* events.latestApplicationSequence.pipe(Effect.orElseSucceed(() => 0));
  yield* forkParked(
    inbox.ensureAll.pipe(
      Effect.andThen(
        Effect.all(
          [
            Stream.runForEach(
              events
                .streamApplicationEvents({ afterSequence })
                .pipe(Stream.filter(isProjectCreated)),
              (event) => inbox.ensure(event.payload.projectId),
            ),
            Stream.runForEach(registry.streamChanges, inbox.retryWaiting),
          ],
          { concurrency: 2, discard: true },
        ),
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning("The Inbox stopped watching for new projects.", cause),
      ),
    ),
  );
});

export const layer = Layer.effectDiscard(watch).pipe(Layer.provideMerge(layerService));
