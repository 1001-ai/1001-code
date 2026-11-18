import {
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  PROJECT_MOMENTS_WINDOW_DAYS,
  type ProjectMoment,
  type ProjectMomentsStreamItem,
  type ProjectMomentsSubscribeInput,
  type MessageId,
  type ThreadId,
} from "@t3tools/contracts";
import { resolveT3McpToolId } from "@t3tools/shared/t3McpToolPresentation";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import {
  isMomentThread,
  makeSentMoments,
  messageMoment,
  pullRequestMoments,
  removedPullRequestMomentIds,
  runMoment,
  runtimeRequestMoment,
  runtimeRequestMomentId,
  toolItemMoment,
  windowMoments,
} from "./projectMoments.logic.ts";
import * as Queries from "./projectMomentsQueries.ts";

/** A project's recent moments, then each change to them as it happens. */
export class ProjectMoments extends Context.Service<
  ProjectMoments,
  {
    readonly subscribe: (
      input: ProjectMomentsSubscribeInput,
    ) => Stream.Stream<ProjectMomentsStreamItem>;
  }
>()("t3/projectMoments/ProjectMoments") {}

const DAY_MILLIS = 24 * 60 * 60 * 1000;
// Threads of other projects seen on the event stream; cleared when it grows past this.
const FOREIGN_THREAD_MEMORY = 5_000;

const THREAD_PAYLOAD_TYPES = new Set<OrchestrationV2DomainEvent["type"]>([
  "thread.created",
  "thread.deleted",
  "thread.metadata-updated",
  "thread.pull-request-synced",
]);
const LIVE_TYPES = new Set<OrchestrationV2DomainEvent["type"]>([
  ...THREAD_PAYLOAD_TYPES,
  "thread.pull-request-link-updated",
  "message.updated",
  "runtime-request.updated",
  "run.updated",
  "turn-item.updated",
]);

const iso = (value: DateTime.Utc) => DateTime.formatIso(value);

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const eventStore = yield* OrchestrationEventStore.OrchestrationEventStore;
  const environment = yield* Effect.serviceOption(ServerEnvironment.ServerEnvironment);
  const peerLinks = yield* Effect.serviceOption(PeerLinks.PeerLinks);

  const query = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>, fallback: A) =>
    effect.pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
      Effect.tapError((cause) => Effect.logWarning("project moments query failed", cause)),
      Effect.orElseSucceed(() => fallback),
    );

  const open = Effect.fn("ProjectMoments.subscribe")(function* (
    input: ProjectMomentsSubscribeInput,
  ) {
    const projectId = input.projectId;
    const sinceMillis = (yield* Clock.currentTimeMillis) - PROJECT_MOMENTS_WINDOW_DAYS * DAY_MILLIS;
    const since = iso(DateTime.makeUnsafe(sinceMillis));
    // Read before the page, so events committed while it loads replay rather than go missing.
    const afterSequence = yield* eventStore
      .latestAgentSequence()
      .pipe(Effect.orElseSucceed(() => 0));
    const ownEnvironmentId = Option.isSome(environment)
      ? yield* environment.value.getEnvironmentId
      : null;
    const labels = new Map<string, string>(
      Option.isSome(peerLinks)
        ? (yield* peerLinks.value.list.pipe(Effect.orElseSucceed(() => []))).map((link) => [
            link.environmentId,
            link.label,
          ])
        : [],
    );
    const environmentLabel = (environmentId: string) => labels.get(environmentId) ?? null;

    const projectThreads = new Map<ThreadId, string>();
    const foreignThreads = new Set<ThreadId>();
    const pullRequestIds = new Map<ThreadId, ReadonlySet<string>>();
    const sent = makeSentMoments();

    const rows = yield* query(Queries.projectThreads(projectId), []);
    for (const row of rows) if (isMomentThread(row)) projectThreads.set(row.threadId, row.title);
    const threadIds = [...projectThreads.keys()];
    const title = (threadId: ThreadId) => projectThreads.get(threadId) ?? "";

    const [messages, requests, runs, toolItems] = yield* Effect.all(
      [
        query(Queries.recentMessages(threadIds, since), []),
        query(Queries.pendingRuntimeRequests(threadIds, since), []),
        query(Queries.completedRuns(threadIds, since), []),
        query(Queries.threadSendItems(threadIds, since), []),
      ],
      { concurrency: 1 },
    );
    const senderIds = [
      ...new Set(messages.flatMap((message) => message.senderThreadId ?? [])),
    ].filter((threadId) => !projectThreads.has(threadId));
    const senderTitles = yield* query(Queries.threadTitles(senderIds), new Map<string, string>());
    const senderTitle = (threadId: ThreadId | null) =>
      threadId === null
        ? null
        : (projectThreads.get(threadId) ?? senderTitles.get(threadId) ?? null);

    const page: ProjectMoment[] = [];
    const push = (moment: ProjectMoment | null) => {
      if (moment !== null) page.push(moment);
    };
    for (const message of messages) {
      push(messageMoment(message, title(message.threadId), senderTitle(message.senderThreadId)));
    }
    for (const request of requests) push(runtimeRequestMoment(request, title(request.threadId)));
    for (const run of runs) push(runMoment(run, title(run.threadId)));
    for (const item of toolItems) {
      push(toolItemMoment(item, title(item.threadId), ownEnvironmentId, environmentLabel));
    }
    for (const row of rows) {
      if (!projectThreads.has(row.threadId)) continue;
      const moments = pullRequestMoments(row.threadId, row.title, row.pullRequests);
      pullRequestIds.set(row.threadId, new Set(moments.map((moment) => moment.id)));
      page.push(...moments);
    }
    const snapshot = windowMoments(page, sinceMillis);
    for (const moment of snapshot.moments) sent.changed(moment);

    const upsert = (moment: ProjectMoment | null): ReadonlyArray<ProjectMomentsStreamItem> =>
      moment !== null && Date.parse(moment.at) >= sinceMillis && sent.changed(moment)
        ? [{ kind: "upsert", moment }]
        : [];

    const removeThread = (threadId: ThreadId): ReadonlyArray<ProjectMomentsStreamItem> => {
      if (!projectThreads.delete(threadId)) return [];
      pullRequestIds.delete(threadId);
      sent.forgetThread(threadId);
      return [{ kind: "remove-thread", threadId }];
    };

    const pullRequestItems = (
      threadId: ThreadId,
      threadTitle: string,
      links: Parameters<typeof pullRequestMoments>[2],
    ): ReadonlyArray<ProjectMomentsStreamItem> => {
      const moments = pullRequestMoments(threadId, threadTitle, links);
      const removed = removedPullRequestMomentIds(
        pullRequestIds.get(threadId) ?? new Set(),
        moments,
      );
      pullRequestIds.set(threadId, new Set(moments.map((moment) => moment.id)));
      for (const id of removed) sent.forget(id);
      return [
        ...removed.map((id): ProjectMomentsStreamItem => ({ kind: "remove", id })),
        ...moments.flatMap(upsert),
      ];
    };

    const onThread = (thread: OrchestrationV2AppThread, deleted: boolean) => {
      const included =
        thread.projectId === projectId &&
        !deleted &&
        thread.deletedAt === null &&
        isMomentThread({
          threadId: thread.id,
          title: thread.title,
          relationshipToParent: thread.lineage.relationshipToParent,
          sideChat: thread.lineage.sideChat === true,
          voiceAgent: thread.lineage.voiceAgent === true,
          delegated: thread.delegatedFrom != null,
        });
      if (!included) {
        rememberForeign(thread.id);
        return removeThread(thread.id);
      }
      foreignThreads.delete(thread.id);
      const previousTitle = projectThreads.get(thread.id);
      projectThreads.set(thread.id, thread.title);
      const retitled =
        previousTitle === undefined || previousTitle === thread.title
          ? []
          : sent.retitled(thread.id, thread.title).flatMap(upsert);
      return [...retitled, ...pullRequestItems(thread.id, thread.title, thread.pullRequests ?? [])];
    };

    const rememberForeign = (threadId: ThreadId) => {
      if (foreignThreads.size >= FOREIGN_THREAD_MEMORY) foreignThreads.clear();
      foreignThreads.add(threadId);
    };

    // A thread's first user message never changes, so one lookup per thread is enough.
    const firstUserMessages = new Map<ThreadId, MessageId>();
    const opensThread = Effect.fnUntraced(function* (threadId: ThreadId, messageId: MessageId) {
      let first = firstUserMessages.get(threadId) ?? null;
      if (first === null) {
        first = yield* query(Queries.firstUserMessageId(threadId), null);
        if (first !== null) firstUserMessages.set(threadId, first);
      }
      return first === messageId;
    });

    /** This project's title for the thread, or null for a thread whose moments do not show. */
    const resolveThread = Effect.fnUntraced(function* (threadId: ThreadId) {
      const known = projectThreads.get(threadId);
      if (known !== undefined) return known;
      if (foreignThreads.has(threadId)) return null;
      const row = yield* query(Queries.threadById(threadId), null);
      if (row === null || row.projectId !== projectId || row.deleted || !isMomentThread(row)) {
        rememberForeign(threadId);
        return null;
      }
      projectThreads.set(threadId, row.title);
      return row.title;
    });

    // Per event, so no span: the stream carries every event of every thread.
    const onEvent = Effect.fnUntraced(function* (event: OrchestrationV2DomainEvent) {
      const none: ReadonlyArray<ProjectMomentsStreamItem> = [];
      switch (event.type) {
        case "thread.created":
        case "thread.deleted":
        case "thread.metadata-updated":
        case "thread.pull-request-synced":
          return onThread(event.payload, event.type === "thread.deleted");
        case "thread.pull-request-link-updated": {
          if ((yield* resolveThread(event.threadId)) === null) return none;
          const row = yield* query(Queries.threadById(event.threadId), null);
          return row === null ? none : pullRequestItems(row.threadId, row.title, row.pullRequests);
        }
        case "message.updated": {
          const message = event.payload;
          if (message.role === "system") return none;
          if (
            message.role === "assistant" &&
            (message.streaming || !message.text.includes("**Q"))
          ) {
            return none;
          }
          const threadTitle = yield* resolveThread(message.threadId);
          if (threadTitle === null) return none;
          const senderThreadId = message.senderThreadId ?? null;
          const sender =
            senderThreadId === null
              ? null
              : (projectThreads.get(senderThreadId) ??
                (yield* query(
                  Queries.threadTitles([senderThreadId]),
                  new Map<string, string>(),
                )).get(senderThreadId) ??
                null);
          return upsert(
            messageMoment(
              {
                id: message.id,
                threadId: message.threadId,
                role: message.role,
                streaming: message.streaming,
                createdAt: iso(message.createdAt),
                updatedAt: iso(message.updatedAt),
                text: message.text,
                createdBy: message.createdBy,
                scheduledTaskId: message.scheduledTaskId ?? null,
                senderThreadId,
                linkedSenderTitle: message.linkedSender?.title ?? null,
                internal:
                  message.idleCompaction !== undefined ||
                  message.delegatedCompletion !== undefined ||
                  message.workflowScript === true,
                notification: message.notification !== undefined,
                opensThread:
                  message.role === "user" && (yield* opensThread(message.threadId, message.id)),
              },
              threadTitle,
              sender,
            ),
          );
        }
        case "runtime-request.updated": {
          const request = event.payload;
          if (request.kind !== "user_input") return none;
          const threadTitle = yield* resolveThread(event.threadId);
          if (threadTitle === null) return none;
          const moment = runtimeRequestMoment(
            {
              id: request.id,
              threadId: event.threadId,
              kind: request.kind,
              status: request.status,
              createdAt: iso(request.createdAt),
            },
            threadTitle,
          );
          if (moment !== null) return upsert(moment);
          const id = runtimeRequestMomentId(request.id);
          sent.forget(id);
          return [{ kind: "remove", id }] satisfies ReadonlyArray<ProjectMomentsStreamItem>;
        }
        case "run.updated": {
          if (event.payload.status !== "completed") return none;
          const threadTitle = yield* resolveThread(event.threadId);
          if (threadTitle === null) return none;
          const run = yield* query(Queries.runById(event.payload.id), null);
          return run === null ? none : upsert(runMoment(run, threadTitle));
        }
        case "turn-item.updated": {
          const item = event.payload;
          if (
            item.type !== "dynamic_tool" ||
            item.status !== "completed" ||
            resolveT3McpToolId(item.toolName) !== "t3_thread_send"
          ) {
            return none;
          }
          const threadTitle = yield* resolveThread(event.threadId);
          if (threadTitle === null) return none;
          return upsert(
            toolItemMoment(
              {
                id: item.id,
                threadId: event.threadId,
                type: item.type,
                status: item.status,
                toolName: item.toolName,
                input: item.input,
                updatedAt: iso(item.updatedAt),
              },
              threadTitle,
              ownEnvironmentId,
              environmentLabel,
            ),
          );
        }
        default:
          return none;
      }
    });

    const live = orchestrator.streamStoredEventsFrom({ afterSequence }).pipe(
      Stream.filter((stored) => LIVE_TYPES.has(stored.event.type)),
      Stream.mapEffect((stored) => onEvent(stored.event)),
      Stream.flattenIterable,
      Stream.orDie,
    );
    const first: ProjectMomentsStreamItem = {
      kind: "snapshot",
      moments: snapshot.moments,
      truncated: snapshot.truncated,
    };
    return Stream.concat(Stream.make(first), live);
  });

  return {
    subscribe: (input) => Stream.unwrap(open(input)),
  } satisfies ProjectMoments["Service"];
});

export const layer = Layer.effect(ProjectMoments, make);
