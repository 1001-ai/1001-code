import {
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
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as InboxAgent from "./InboxAgent.ts";
import { inboxAgentThread } from "./inboxAgentThread.ts";

const PROJECT = ProjectId.make("project-acme");
const OTHER_PROJECT = ProjectId.make("project-other");

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

type Create = Extract<OrchestrationV2ServerCommand, { readonly type: "thread.create" }>;

/** The Inbox over fakes: thread shells kept in memory, the way the orchestrator would keep them. */
const withInbox = <A, E>(
  test: (fixture: {
    readonly service: InboxAgent.InboxAgent["Service"];
    readonly created: Array<Create>;
    readonly shells: Map<ThreadId, OrchestrationV2ThreadShell & { deletedAt?: unknown }>;
    readonly setProviders: (providers: ReadonlyArray<ServerProvider>) => void;
    readonly setEnabled: (enabled: boolean) => void;
  }) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const shells = new Map<ThreadId, OrchestrationV2ThreadShell & { deletedAt?: unknown }>();
    const created: Array<Create> = [];
    let providers: ReadonlyArray<ServerProvider> = [claude()];
    let enabled = true;
    const live = (archived: boolean, projectId: ProjectId | undefined) =>
      [...shells.values()].filter(
        (shell) =>
          shell.deletedAt == null &&
          (shell.archivedAt !== null) === archived &&
          (projectId === undefined || shell.projectId === projectId),
      );
    const service = yield* InboxAgent.InboxAgent.pipe(
      Effect.provide(
        InboxAgent.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.mock(ProviderRegistry.ProviderRegistry)({
                getProviders: Effect.sync(() => providers),
              }),
              Layer.mock(ThreadManagementService.ThreadManagementService)({
                getThreadShell: (threadId) => Effect.sync(() => shells.get(threadId) ?? null),
                getShellSnapshot: (options) =>
                  Effect.sync(
                    () =>
                      ({
                        threads: live(options?.location === "archive", options?.projectId),
                      }) as never,
                  ),
                isProviderInstanceEnabledForProject: () => Effect.sync(() => enabled),
                dispatch: (command) =>
                  Effect.gen(function* () {
                    if (command.type !== "thread.create") throw new Error(command.type);
                    // Two opens racing would both get here without the service's lock.
                    yield* Effect.yieldNow;
                    created.push(command);
                    const shell = {
                      ...liveThreadShell(command.threadId),
                      projectId: command.projectId,
                      activeRunId: null,
                    };
                    // What the orchestrator's thread.create does with `inboxAgent`.
                    shells.set(command.threadId, {
                      ...shell,
                      ...inboxAgentThread(shell as never, command.inboxAgent),
                    } as OrchestrationV2ThreadShell);
                    return undefined as never;
                  }),
              }),
            ),
          ),
        ),
      ),
    );
    return yield* test({
      service,
      created,
      shells,
      setProviders: (next) => {
        providers = next;
      },
      setEnabled: (next) => {
        enabled = next;
      },
    });
  });

it.effect("makes a project's Inbox once, stamped as a parentless side chat on Claude", () =>
  withInbox(({ service, created, shells }) =>
    Effect.gen(function* () {
      const first = yield* service.open({ projectId: PROJECT });
      expect(first.status).toBe("ready");
      expect(created).toHaveLength(1);
      expect(created[0]).toMatchObject({
        projectId: PROJECT,
        title: INBOX_AGENT_THREAD_TITLE,
        modelSelection: { instanceId: "claudeAgent", model: INBOX_AGENT_DEFAULT_MODEL },
        runtimeMode: "approval-required",
        worktreePath: null,
        inboxAgent: true,
        createdBy: "system",
        creationSource: "server",
      });
      const threadId = first.status === "ready" ? first.threadId : null;
      expect(shells.get(threadId!)?.lineage).toEqual({
        parentThreadId: null,
        relationshipToParent: null,
        rootThreadId: threadId,
        sideChat: true,
        inboxAgent: true,
      });

      expect(yield* service.open({ projectId: PROJECT })).toEqual(first);
      expect(created).toHaveLength(1);
      // Another project gets its own.
      yield* service.open({ projectId: OTHER_PROJECT });
      expect(created.map((command) => command.projectId)).toEqual([PROJECT, OTHER_PROJECT]);
    }),
  ),
);

it.effect("makes one thread when two first opens race", () =>
  withInbox(({ service, created }) =>
    Effect.gen(function* () {
      const [left, right] = yield* Effect.all(
        [service.open({ projectId: PROJECT }), service.open({ projectId: PROJECT })],
        { concurrency: 2 },
      );
      expect(created).toHaveLength(1);
      expect(left).toEqual(right);
    }),
  ),
);

it.effect("finds an Inbox the server made before, archived or not, without making another", () =>
  withInbox(({ service, created, shells }) =>
    Effect.gen(function* () {
      const old = ThreadId.make("inbox-old");
      const base = { ...liveThreadShell(old), projectId: PROJECT };
      shells.set(old, {
        ...base,
        ...inboxAgentThread(base as never, true),
        archivedAt: DateTime.makeUnsafe(0),
      } as OrchestrationV2ThreadShell);
      // An ordinary thread of the project is never taken for it.
      shells.set(ThreadId.make("chat"), {
        ...liveThreadShell(ThreadId.make("chat")),
        projectId: PROJECT,
      });
      expect(yield* service.open({ projectId: PROJECT })).toEqual({
        status: "ready",
        threadId: old,
      });
      expect(created).toEqual([]);
    }),
  ),
);

it.effect("makes a new Inbox after the old one is deleted", () =>
  withInbox(({ service, created, shells }) =>
    Effect.gen(function* () {
      const first = yield* service.open({ projectId: PROJECT });
      const firstId = first.status === "ready" ? first.threadId : null;
      shells.set(firstId!, { ...shells.get(firstId!)!, deletedAt: DateTime.makeUnsafe(0) });
      const second = yield* service.open({ projectId: PROJECT });
      expect(created).toHaveLength(2);
      expect(second.status === "ready" && second.threadId).not.toBe(firstId);
    }),
  ),
);

it.effect("makes nothing and says why without a usable Claude provider", () =>
  withInbox(({ service, created, setProviders, setEnabled }) =>
    Effect.gen(function* () {
      setProviders([claude({ auth: { status: "unauthenticated" } as never })]);
      const signedOut = yield* service.open({ projectId: PROJECT });
      expect(signedOut.status).toBe("unavailable");
      expect(signedOut.status === "unavailable" && signedOut.message).toContain(
        "no Claude provider is ready",
      );

      setProviders([claude()]);
      setEnabled(false);
      const off = yield* service.open({ projectId: PROJECT });
      expect(off.status === "unavailable" && off.message).toContain("turned off for this project");
      expect(created).toEqual([]);
    }),
  ),
);
