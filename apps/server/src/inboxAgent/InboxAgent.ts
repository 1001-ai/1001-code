import {
  CommandId,
  INBOX_AGENT_DEFAULT_EFFORT,
  INBOX_AGENT_THREAD_TITLE,
  InboxAgentError,
  type InboxAgentResetResult,
  type ApplicationProjectCreatedEvent,
  type ApplicationStoredEvent,
  type OrchestrationV2ThreadShell,
  ProjectId,
  type ServerProvider,
  ThreadId,
  inboxAgentDefaultModel,
  isInboxThreadShell,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import { lockedAgentProvider, lockedAgentProviders } from "../lockedAgents/lockedAgentProvider.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
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
  /** No usable Inbox provider here, or all are off for the project: retried when providers change. */
  | { readonly status: "waiting-for-provider" }
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
    /** `ensureAll` again when a project waits for a provider and one is now ready. */
    readonly retryWaiting: (providers: ReadonlyArray<ServerProvider>) => Effect.Effect<void>;
    /** Replaces the project's Inbox thread with a brand-new empty one, deleting the old thread. */
    readonly reset: (projectId: ProjectId) => Effect.Effect<InboxAgentResetResult, InboxAgentError>;
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

/** What `ensure` reads of an Inbox thread. */
type InboxShell = Pick<
  OrchestrationV2ThreadShell,
  | "id"
  | "projectId"
  | "title"
  | "createdBy"
  | "creationSource"
  | "lineage"
  | "createdAt"
  | "runtimeMode"
  | "activeRunId"
  | "updatedAt"
>;

/** The oldest thread of a project that looks like its Inbox, as clients pick it. */
function oldestInboxShell(
  shells: ReadonlyArray<InboxShell>,
  projectId: ProjectId,
): InboxShell | null {
  let found: InboxShell | null = null;
  for (const shell of shells) {
    if (shell.projectId !== projectId || !isInboxThreadShell(shell)) continue;
    if (
      found === null ||
      DateTime.toEpochMillis(shell.createdAt) < DateTime.toEpochMillis(found.createdAt)
    ) {
      found = shell;
    }
  }
  return found;
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
  // Set when a project was skipped for want of a supported provider; a provider change then retries.
  let waitingForProvider = false;
  let created = 0;

  /** The recorded thread's shell while it is still the project's Inbox, else null. */
  const liveThread = (threadId: ThreadId, projectId: ProjectId) =>
    threads
      .getThreadShell(threadId)
      .pipe(
        Effect.map((shell) =>
          shell !== null &&
          shell.deletedAt == null &&
          shell.projectId === projectId &&
          isInboxThreadShell(shell)
            ? shell
            : null,
        ),
      );

  const findAllExisting = (projectId: ProjectId) =>
    Effect.all(
      [
        threads.getShellSnapshot({ projectId }),
        threads.getShellSnapshot({ projectId, location: "archive" }),
      ],
      { concurrency: 2 },
    ).pipe(
      Effect.map(([active, archived]) =>
        [...active.threads, ...archived.threads].filter(
          (shell) => shell.projectId === projectId && isInboxThreadShell(shell),
        ),
      ),
    );

  const findExisting = (projectId: ProjectId) =>
    findAllExisting(projectId).pipe(Effect.map((shells) => oldestInboxShell(shells, projectId)));

  const create = Effect.fn("InboxAgent.create")(function* (projectId: ProjectId) {
    let provider: ServerProvider | undefined;
    for (const candidate of lockedAgentProviders(yield* registry.getProviders, "inbox")) {
      const enabled = yield* threads.isProviderInstanceEnabledForProject({
        projectId,
        instanceId: candidate.instanceId,
      });
      if (enabled) {
        provider = candidate;
        break;
      }
    }
    if (provider === undefined) return null;
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
      modelSelection: {
        instanceId: provider.instanceId,
        model: inboxAgentDefaultModel(provider.driver),
        ...(provider.driver === "claudeAgent"
          ? { options: [{ id: "effort", value: INBOX_AGENT_DEFAULT_EFFORT }] }
          : {}),
      },
      // `t3_thread_send` refuses targets in broader modes than the caller's. The tool lock still
      // gives the Inbox no shell or file tools. `upgradeRuntimeMode` raises an older Inbox.
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "system",
      creationSource: "server",
    });
    return threadId;
  });

  /**
   * Raises an Inbox an older build made at `approval-required` to `full-access`, as `create`
   * makes it. Claude cannot switch modes in a session, so the change ends the Inbox's session: a
   * running Inbox is left for the next ensure. A failure only logs; the Inbox is still returned.
   */
  let raises = 0;
  const upgradeRuntimeMode = Effect.fn("InboxAgent.upgradeRuntimeMode")(function* (
    shell: InboxShell,
  ) {
    if (shell.runtimeMode === "full-access" || shell.activeRunId !== null) return;
    raises += 1;
    yield* threads
      .dispatch({
        type: "thread.runtime-mode.set",
        // Each try gets its own id: a refusal is recorded against its id and would refuse every
        // later try that reused it.
        commandId: CommandId.make(
          `inbox-agent:runtime-mode:${shell.id}:${(yield* Clock.currentTimeMillis).toString(36)}-${raises}`,
        ),
        threadId: shell.id,
        runtimeMode: "full-access",
      })
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("The Inbox's runtime mode was not raised.", {
            threadId: shell.id,
            cause,
          }),
        ),
      );
  });

  const ensureUnlocked = Effect.fn("InboxAgent.ensure")(function* (projectId: ProjectId) {
    if (yield* managedFolders.isScratchProject(projectId)) return { status: "skipped" } as const;
    const recorded = inboxThreadOf(projectId);
    const recordedShell = recorded === undefined ? null : yield* liveThread(recorded, projectId);
    if (recordedShell !== null) {
      yield* upgradeRuntimeMode(recordedShell);
      return { status: "ready", threadId: recordedShell.id, created: false } as const;
    }
    const existingShell = yield* findExisting(projectId);
    if (existingShell !== null) yield* upgradeRuntimeMode(existingShell);
    const existing = existingShell?.id ?? null;
    const threadId = existing ?? (yield* create(projectId));
    if (threadId === null) {
      waitingForProvider = true;
      return { status: "waiting-for-provider" } as const;
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
    waitingForProvider = false;
    const rows = yield* projects.list().pipe(Effect.orElseSucceed(() => []));
    yield* Effect.forEach(rows, (row) => ensure(row.projectId), { discard: true });
  }).pipe(Effect.withSpan("InboxAgent.ensureAll"));

  const retryWaiting: InboxAgent["Service"]["retryWaiting"] = (providers) =>
    waitingForProvider && lockedAgentProvider(providers, "inbox") !== undefined
      ? ensureAll
      : Effect.void;

  const isInboxAgentError = Schema.is(InboxAgentError);

  const resetUnlocked = Effect.fn("InboxAgent.reset")(function* (projectId: ProjectId) {
    if (yield* managedFolders.isScratchProject(projectId)) {
      return yield* new InboxAgentError({ reason: "unsupported" });
    }
    const project = yield* projects.get(projectId);
    if (Option.isNone(project)) {
      return yield* new InboxAgentError({ reason: "project-not-found" });
    }
    const recorded = inboxThreadOf(projectId);
    const recordedShell = recorded === undefined ? null : yield* liveThread(recorded, projectId);
    const existingShells = yield* findAllExisting(projectId);
    const previousThreadId =
      recordedShell?.id ?? oldestInboxShell(existingShells, projectId)?.id ?? null;
    const oldThreadIds = Array.from(
      new Set([
        ...existingShells.map((shell) => shell.id),
        ...(recordedShell ? [recordedShell.id] : []),
      ]),
    );
    // Delete duplicates before the primary Inbox thread so a failed delete never drops the live Inbox.
    const orderedOldIds =
      previousThreadId === null
        ? oldThreadIds
        : [...oldThreadIds.filter((id) => id !== previousThreadId), previousThreadId];
    // Make the replacement before deleting the old thread, so an unavailable provider loses nothing.
    const nextThreadId = yield* create(projectId);
    if (nextThreadId === null) {
      waitingForProvider = true;
      return yield* new InboxAgentError({ reason: "unavailable" });
    }
    // Delete old Inbox threads while they are still marked as Inbox threads, so a running turn stays locked until deleted.
    for (const oldId of orderedOldIds) {
      if (oldId === nextThreadId) continue;
      const deleted = yield* threads
        .dispatch({
          type: "thread.delete",
          commandId: CommandId.make(`inbox-agent:reset-delete:${oldId}:${nextThreadId}`),
          threadId: oldId,
        })
        .pipe(
          Effect.as(true),
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              if ((yield* liveThread(oldId, projectId)) === null) return true;
              yield* Effect.logWarning("The old Inbox thread could not be deleted during reset.", {
                projectId,
                oldId,
                nextThreadId,
                cause,
              });
              return false;
            }),
          ),
        );
      if (!deleted) {
        yield* threads
          .dispatch({
            type: "thread.delete",
            commandId: CommandId.make(`inbox-agent:reset-rollback:${nextThreadId}`),
            threadId: nextThreadId,
          })
          .pipe(Effect.ignore);
        return yield* new InboxAgentError({ reason: "failed" });
      }
    }
    recordInboxThread(projectId, nextThreadId);
    yield* writeState;
    return { threadId: nextThreadId, previousThreadId } satisfies InboxAgentResetResult;
  });

  const reset: InboxAgent["Service"]["reset"] = (projectId) =>
    lock
      .withPermits(1)(resetUnlocked(projectId))
      .pipe(
        Effect.catchIf(
          (error) => !isInboxAgentError(error),
          (error) =>
            Effect.logWarning("The project's Inbox could not be reset.", {
              projectId,
              error,
            }).pipe(Effect.andThen(Effect.fail(new InboxAgentError({ reason: "failed" })))),
        ),
        Effect.catchDefect((defect) =>
          Effect.logWarning("The project's Inbox could not be reset.", {
            projectId,
            defect,
          }).pipe(Effect.andThen(Effect.fail(new InboxAgentError({ reason: "failed" })))),
        ),
      );

  return InboxAgent.of({ isInboxThread, ensure, ensureAll, retryWaiting, reset });
});

/** The service alone, without its triggers. */
export const layerService = Layer.effect(InboxAgent, make);

const isProjectCreated = (event: ApplicationStoredEvent): event is ApplicationProjectCreatedEvent =>
  "type" in event && event.type === "project.created";

/**
 * The triggers: startup, new projects, and provider or settings changes. Kept beside `ensure` so
 * changing when an Inbox is made (for example only when someone names a thread "Inbox") touches
 * only this function.
 */
const watch = Effect.gen(function* () {
  const inbox = yield* InboxAgent;
  const events = yield* OrchestrationEventStore.OrchestrationEventStore;
  const registry = yield* ProviderRegistry.ProviderRegistry;
  const settings = yield* ServerSettings.ServerSettingsService;
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
            // Turning Claude on for a project is a settings change, not a provider change.
            Stream.runForEach(settings.streamChanges, () =>
              registry.getProviders.pipe(Effect.flatMap(inbox.retryWaiting)),
            ),
          ],
          { concurrency: 3, discard: true },
        ),
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning("The Inbox stopped watching for new projects.", cause),
      ),
    ),
  );
});

export const layer = Layer.effectDiscard(watch).pipe(Layer.provideMerge(layerService));
