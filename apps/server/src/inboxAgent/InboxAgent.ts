import {
  CommandId,
  INBOX_AGENT_DEFAULT_MODEL,
  INBOX_AGENT_THREAD_TITLE,
  InboxAgentError,
  type InboxAgentOpenInput,
  type InboxAgentOpenResult,
  type OrchestrationV2ThreadShell,
  type ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";

import { lockedAgentProvider } from "../lockedAgents/lockedAgentProvider.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import { isInboxAgentThread } from "./inboxAgentThread.ts";

export class InboxAgent extends Context.Service<
  InboxAgent,
  {
    /**
     * The project's Inbox thread: the one that exists, archived or not, or a new one made on
     * this first open. Made once per project, and again only after it is deleted.
     */
    readonly open: (
      input: InboxAgentOpenInput,
    ) => Effect.Effect<InboxAgentOpenResult, InboxAgentError>;
  }
>()("t3/inboxAgent/InboxAgent") {}

const NO_CLAUDE_MESSAGE =
  "The Inbox runs on Claude, and no Claude provider is ready on this server. Install Claude Code and sign in to it under Settings, then open the Inbox again.";
const CLAUDE_OFF_FOR_PROJECT_MESSAGE =
  "The Inbox runs on Claude, and Claude is turned off for this project. Turn it on in the project's settings, then open the Inbox again.";

/** The oldest Inbox thread of a project, when there is one. */
function findInboxAgentThread(
  shells: ReadonlyArray<
    Pick<OrchestrationV2ThreadShell, "id" | "projectId" | "lineage" | "createdAt">
  >,
  projectId: ProjectId,
): ThreadId | null {
  let found: (typeof shells)[number] | null = null;
  for (const shell of shells) {
    if (shell.projectId !== projectId || !isInboxAgentThread(shell)) continue;
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
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const registry = yield* ProviderRegistry.ProviderRegistry;
  // One open at a time, so two first opens never make two threads.
  const lock = yield* Semaphore.make(1);
  // A project's Inbox thread, once found or made: its id never changes until it is deleted.
  const known = new Map<ProjectId, ThreadId>();
  let created = 0;

  const liveInbox = (threadId: ThreadId, projectId: ProjectId) =>
    threads.getThreadShell(threadId).pipe(
      Effect.map(
        (shell) =>
          shell !== null &&
          shell.deletedAt == null &&
          shell.projectId === projectId &&
          isInboxAgentThread(shell),
      ),
      Effect.orElseSucceed(() => false),
    );

  const findExisting = Effect.fn("InboxAgent.findExisting")(function* (projectId: ProjectId) {
    const [active, archived] = yield* Effect.all(
      [
        threads.getShellSnapshot({ projectId }),
        threads.getShellSnapshot({ projectId, location: "archive" }),
      ],
      { concurrency: 2 },
    );
    return findInboxAgentThread([...active.threads, ...archived.threads], projectId);
  });

  const create = Effect.fn("InboxAgent.create")(function* (projectId: ProjectId) {
    const provider = lockedAgentProvider(yield* registry.getProviders);
    if (provider === undefined) {
      return { status: "unavailable", message: NO_CLAUDE_MESSAGE } as const;
    }
    const enabled = yield* threads.isProviderInstanceEnabledForProject({
      projectId,
      instanceId: provider.instanceId,
    });
    if (!enabled)
      return { status: "unavailable", message: CLAUDE_OFF_FOR_PROJECT_MESSAGE } as const;
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
      inboxAgent: true,
      createdBy: "system",
      creationSource: "server",
    });
    known.set(projectId, threadId);
    return { status: "ready", threadId } as const;
  });

  const open: InboxAgent["Service"]["open"] = Effect.fn("InboxAgent.open")(function* (input) {
    const { projectId } = input;
    return yield* lock.withPermits(1)(
      Effect.gen(function* () {
        const cached = known.get(projectId);
        if (cached !== undefined) {
          if (yield* liveInbox(cached, projectId)) {
            return { status: "ready", threadId: cached } as const;
          }
          known.delete(projectId);
        }
        const existing = yield* findExisting(projectId);
        if (existing !== null) {
          known.set(projectId, existing);
          return { status: "ready", threadId: existing } as const;
        }
        return yield* create(projectId);
      }).pipe(
        Effect.tapError((cause) =>
          Effect.logWarning("The Inbox thread could not be opened.", cause),
        ),
        Effect.mapError(() => new InboxAgentError({ reason: "not-created" })),
      ),
    );
  });

  return InboxAgent.of({ open });
});

export const layer = Layer.effect(InboxAgent, make);
