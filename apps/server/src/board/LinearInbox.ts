import {
  type BoardError,
  CommandId,
  EnvironmentId,
  MessageId,
  OrchestrationV2LinkedSender,
  type OrchestrationV2ThreadShell,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { type InboxForwardArguments, inboxForwardCheck } from "../inboxAgent/inboxAgentForward.ts";
import { inboxThreadOf } from "../inboxAgent/inboxAgentThreads.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as TeamCatalog from "../teamCatalog/TeamCatalog.ts";
import * as Board from "./Board.ts";
import {
  LinearInboxLogEntry,
  deliveredTo,
  prunedLog,
  publishLinearInboxLog,
} from "./linearInboxLog.ts";
import {
  DAILY_THREAD_LIMIT,
  INBOX_PAGE_SIZE,
  INBOX_PROBE_QUERY,
  INBOX_QUERY,
  InboxData,
  InboxProbeData,
  type LinearComment,
  type LinearMappedProject,
  MAX_INBOX_PAGES,
  type SkipReason,
  commentKind,
  exchangeSkipReason,
  framedComment,
  inboxMessageKey,
  isShownSkip,
  projectsForIssue,
  recentDeliveries,
  routeComment,
  senderThread,
  threadSkipReason,
} from "./linearInboxRouting.ts";

/**
 * Delivers teammates' Linear comments into local threads (see `routeComment`) as queued messages,
 * and an agent comment no thread takes to the Inbox of the project its team maps to. Each
 * delivery and skip is logged for the Inbox digest; the log decides what a thread may answer.
 */
export class LinearInbox extends Context.Service<
  LinearInbox,
  {
    /** One pass: failed deliveries again, then every team; the layer runs it every 10 seconds. */
    readonly poll: Effect.Effect<void>;
    /** Passes a teammate's message the Inbox received on, unchanged, to one of its project's threads. */
    readonly forward: (input: {
      readonly inboxThreadId: ThreadId;
      readonly environmentId: EnvironmentId;
      readonly forward: InboxForwardArguments;
    }) => Effect.Effect<LinearInboxForwardResult, LinearInboxRefusal>;
    /**
     * Answers a comment in its exchange on Linear, with the thread's reply address; refused
     * unless the comment was delivered or forwarded to this thread.
     */
    readonly reply: (input: {
      readonly thread: { readonly id: ThreadId; readonly title: string };
      readonly commentId: string;
      readonly text: string;
    }) => Effect.Effect<Board.BoardMessageResult, LinearInboxRefusal | BoardError>;
  }
>()("t3/board/LinearInbox") {}

export interface LinearInboxForwardResult {
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly delivery: ThreadManagement.ThreadManagementSendResult["delivery"];
}

/** A refused or failed forward, for the agent to read. */
export class LinearInboxRefusal extends Schema.TaggedError<LinearInboxRefusal>()(
  "LinearInboxRefusal",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

/**
 * Linear allows an OAuth app 5,000 requests an hour per user (checked 2026-11-19): a 10-second
 * probe is 360 of them.
 */
const POLL_INTERVAL = Duration.seconds(10);

const Delivery = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  commentId: Schema.String,
  text: Schema.String,
  linkedSender: OrchestrationV2LinkedSender,
});
type Delivery = typeof Delivery.Type;

/** Kept in the state directory, so a restart neither replays comments nor resets the limits. */
const InboxState = Schema.fromJsonString(
  Schema.Struct({
    /** Per team key, the creation time of the newest comment already read. */
    cursors: Schema.Record(Schema.String, Schema.String),
    /** Per thread, when comments were delivered in the last day. */
    delivered: Schema.Record(Schema.String, Schema.Array(Schema.String)),
    /** Comments whose delivery failed, with when they arrived, waiting for another try. */
    held: Schema.Array(
      Schema.Struct({
        ...Delivery.fields,
        since: Schema.String,
        attempts: Schema.Number,
        /** What the log records once it is delivered. */
        entry: Schema.optional(LinearInboxLogEntry),
      }),
    ),
    log: Schema.optional(Schema.Array(LinearInboxLogEntry)),
  }),
);
type InboxState = typeof InboxState.Type;
const decodeState = Schema.decodeUnknownOption(InboxState);
const encodeState = Schema.encodeSync(InboxState);

/** A comment whose delivery failed this many times is dropped. */
const MAX_DELIVERY_ATTEMPTS = 5;

/** Stands in for a sender whose comment links no thread, so clients still show its name. */
const LINEAR_ENVIRONMENT = EnvironmentId.make("linear");

const make = Effect.gen(function* () {
  const board = yield* Board.Board;
  const teamCatalog = yield* TeamCatalog.TeamCatalog;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const instances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const environmentId = yield* (yield* ServerEnvironment.ServerEnvironment).getEnvironmentId;
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const random = yield* SecureRandom.SecureRandom;
  // A poll and a forward both change the state; one at a time.
  const lock = yield* Semaphore.make(1);

  const statePath = path.join(config.stateDir, "linear-inbox.json");
  const stored = yield* fileSystem
    .readFileString(statePath)
    .pipe(Effect.map(decodeState), Effect.orElseSucceed(Option.none));
  let state: InboxState = Option.getOrElse(stored, () => ({
    cursors: {},
    delivered: {},
    held: [],
  }));
  let log = state.log ?? [];
  publishLinearInboxLog(log);
  const saveState = Effect.suspend(() =>
    fileSystem.writeFileString(statePath, encodeState({ ...state, log })),
  ).pipe(
    Effect.catch((cause) => Effect.logWarning("Linear inbox could not save its state.", cause)),
  );

  const record = (entry: LinearInboxLogEntry) => {
    log = [...log, entry];
    publishLinearInboxLog(log);
  };

  const countDelivery = (threadId: ThreadId, at: string) => {
    state = {
      ...state,
      delivered: { ...state.delivered, [threadId]: [...(state.delivered[threadId] ?? []), at] },
    };
  };

  const deliver = Effect.fn("LinearInbox.deliver")(function* (delivery: Delivery) {
    const key = inboxMessageKey(delivery.threadId, delivery.commentId);
    const result = yield* threads.sendToThread({
      projectId: delivery.projectId,
      commandId: CommandId.make(key),
      threadId: delivery.threadId,
      messageId: MessageId.make(key),
      linkedSender: delivery.linkedSender,
      text: delivery.text,
      attachments: [],
      mode: "queue",
      createdBy: "agent",
      creationSource: "mcp",
    });
    countDelivery(delivery.threadId, DateTime.formatIso(yield* DateTime.now));
    yield* Effect.logInfo("Linear inbox delivered a comment.", {
      comment: delivery.commentId,
      threadId: delivery.threadId,
      delivery: result.delivery,
    });
    return result;
  });

  type Held = InboxState["held"][number];

  /** Delivers now, or holds the comment for another try; a retried delivery is a receipt replay. */
  const deliverOrHold = Effect.fnUntraced(function* (held: Held) {
    const failure = yield* deliver(held).pipe(
      Effect.as(null),
      Effect.catch((error) => Effect.succeed(error)),
    );
    const at = DateTime.formatIso(yield* DateTime.now);
    if (failure === null) {
      if (held.entry !== undefined) record({ ...held.entry, at });
      return null;
    }
    const attempts = held.attempts + 1;
    if (attempts >= MAX_DELIVERY_ATTEMPTS) {
      yield* Effect.logError("Linear inbox gave up delivering a comment.", {
        comment: held.commentId,
        threadId: held.threadId,
        error: failure,
      });
      if (held.entry !== undefined) {
        const { via: _via, ...entry } = held.entry;
        record({ ...entry, at, outcome: "not-delivered", reason: "delivery-failed" });
      }
      return null;
    }
    yield* Effect.logWarning("Linear inbox will try a comment again.", {
      comment: held.commentId,
      threadId: held.threadId,
      attempts,
      error: failure,
    });
    return { ...held, attempts };
  });

  /** Failed deliveries are tried again; only a deleted or archived thread drops them. */
  const releaseHeld = Effect.fn("LinearInbox.releaseHeld")(function* () {
    const kept: Array<Held> = [];
    for (const item of state.held) {
      const thread = yield* threads
        .getThreadShell(item.threadId)
        .pipe(Effect.orElseSucceed(() => undefined));
      if (thread === undefined) {
        kept.push(item);
        continue;
      }
      if (thread === null || thread.archivedAt !== null) {
        yield* Effect.logInfo("Linear inbox drops a comment for a thread that is gone.", {
          comment: item.commentId,
          threadId: item.threadId,
        });
        continue;
      }
      const retry = yield* deliverOrHold(item);
      if (retry !== null) kept.push(retry);
    }
    state = { ...state, held: kept };
  });

  /** The first of a candidate's threads that exists, read now. */
  const firstThread = Effect.fnUntraced(function* (threadIds: ReadonlyArray<ThreadId>) {
    for (const threadId of threadIds) {
      const thread = yield* threads.getThreadShell(threadId);
      if (thread !== null) return { threadId, thread };
    }
    return null;
  });

  type Target = {
    readonly threadId: ThreadId;
    readonly thread: OrchestrationV2ThreadShell;
    readonly via: NonNullable<LinearInboxLogEntry["via"]>;
  };

  const handleComment = Effect.fnUntraced(function* (
    comment: LinearComment,
    team: string,
    context: {
      readonly viewerId: string;
      readonly memberIds: ReadonlySet<string>;
      readonly mapped: ReadonlyArray<LinearMappedProject>;
      readonly now: DateTime.Utc;
    },
  ) {
    const nowMs = context.now.epochMilliseconds;
    const at = DateTime.formatIso(context.now);
    const { issue, user } = comment;
    const fields = { comment: comment.id, issue: issue?.identifier ?? null };
    const projectIds = issue === null ? [] : projectsForIssue(context.mapped, team, issue.project);
    const sender = user === null ? "" : user.name || user.displayName;
    const base =
      issue === null
        ? null
        : {
            commentId: comment.id,
            rootId: comment.parent?.id ?? comment.id,
            issueId: issue.id,
            issue: issue.identifier,
            sender,
            kind: commentKind(comment.body),
            at,
          };
    const skipped = (
      reason: SkipReason,
      thread?: { readonly threadId: ThreadId; readonly projectId: ProjectId },
    ) =>
      Effect.suspend(() => {
        if (base !== null && isShownSkip(reason)) {
          record({
            ...base,
            outcome: "not-delivered",
            reason,
            ...(thread === undefined ? {} : { threadId: thread.threadId }),
            projectIds: thread === undefined ? projectIds : [thread.projectId],
          });
        }
        return Effect.logInfo("Linear inbox skips a comment.", {
          ...fields,
          threadId: thread?.threadId ?? null,
          reason,
        });
      });

    const route = routeComment(comment, {
      viewerId: context.viewerId,
      environmentId,
      memberIds: context.memberIds,
    });
    if (route._tag === "skip") return yield* skipped(route.reason);
    if (base === null) return;

    // A failed read fails the poll before the cursor passes this comment, so it is read again.
    let target: Target | null = null;
    let missing = false;
    for (const candidate of route.candidates) {
      const found = yield* firstThread(candidate.threadIds);
      // A thread the comment names must belong to a project its team maps to.
      if (
        found !== null &&
        (candidate.via !== "body-link" || projectIds.includes(found.thread.projectId))
      ) {
        target = { ...found, via: candidate.via };
        break;
      }
      if (found === null && candidate.via === "issue-link") missing = true;
    }
    if (target === null) {
      if (route.kind !== "agent")
        return yield* skipped(missing ? "thread-missing" : "no-thread-link");
      const [projectId, ...others] = projectIds;
      if (projectId === undefined) return yield* skipped("no-project");
      if (others.length > 0) return yield* skipped("several-projects");
      const inboxId = inboxThreadOf(projectId);
      const inbox = inboxId === undefined ? null : yield* threads.getThreadShell(inboxId);
      if (inboxId === undefined || inbox === null) return yield* skipped("no-inbox");
      target = { threadId: inboxId, thread: inbox, via: "inbox" };
    }

    const { threadId, thread, via } = target;
    const instance = yield* instances.getInstance(thread.providerInstanceId);
    // Waiting retries count for a day from when they arrived, like delivered ones.
    const waiting =
      recentDeliveries(state.delivered[threadId] ?? [], nowMs).length +
      recentDeliveries(
        state.held.filter((item) => item.threadId === threadId).map((item) => item.since),
        nowMs,
      ).length;
    const reason =
      threadSkipReason(thread, instance?.driverKind, via === "inbox" ? null : nowMs) ??
      exchangeSkipReason(comment, context.memberIds) ??
      (waiting >= DAILY_THREAD_LIMIT ? "daily-limit" : null);
    if (reason !== null) {
      return yield* skipped(reason, { threadId, projectId: thread.projectId });
    }
    const delivery: Delivery = {
      threadId,
      projectId: thread.projectId,
      commentId: comment.id,
      text: framedComment({
        body: comment.body,
        issue: base.issue,
        sender,
        kind: route.kind,
        nonce: Hex.encode(yield* random.randomBytes(4)),
        commentId: comment.id,
        url: comment.url,
      }),
      linkedSender: {
        ...(senderThread(comment.body, environmentId) ?? {
          environmentId: LINEAR_ENVIRONMENT,
          threadId: ThreadId.make(`linear-comment-${comment.id}`),
        }),
        title: route.kind === "agent" ? `${sender}'s agent` : sender,
      },
    };
    const retry = yield* deliverOrHold({
      ...delivery,
      since: at,
      attempts: 0,
      entry: { ...base, outcome: "delivered", via, threadId, projectIds: [thread.projectId] },
    });
    if (retry !== null) state = { ...state, held: [...state.held, retry] };
  });

  const pollTeam = Effect.fn("LinearInbox.pollTeam")(function* (
    team: string,
    since: string,
    session: Board.BoardLinearSession,
    mapped: ReadonlyArray<LinearMappedProject>,
  ) {
    const now = yield* DateTime.now;
    // Linear lists newest first, so the cursor may move only after every page is read.
    const pages: Array<InboxData> = [];
    let after: string | null = null;
    for (let page = 0; page < MAX_INBOX_PAGES; page += 1) {
      const data: InboxData = yield* session.query(
        INBOX_QUERY,
        { key: team, since, first: INBOX_PAGE_SIZE, after },
        InboxData,
      );
      pages.push(data);
      after = data.comments.pageInfo.endCursor;
      if (!data.comments.pageInfo.hasNextPage || after === null) break;
    }
    if (pages.at(-1)?.comments.pageInfo.hasNextPage) {
      yield* Effect.logWarning("Linear inbox skipped the oldest new comments.", { team });
    }
    const memberIds = new Set(pages[0]?.teams.nodes[0]?.members.nodes.map((member) => member.id));
    const comments = pages
      .flatMap((data) => data.comments.nodes)
      .toSorted((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const comment of comments) {
      yield* handleComment(comment, team, { viewerId: session.viewerId, memberIds, mapped, now });
      state = { ...state, cursors: { ...state.cursors, [team]: comment.createdAt } };
    }
  });

  /** Whether any of the teams has a comment after the oldest of their cursors. */
  const anythingNew = (session: Board.BoardLinearSession, teams: ReadonlyArray<string>) => {
    const since = teams
      .map((team) => state.cursors[team]!)
      .toSorted((a, b) => a.localeCompare(b))[0];
    return session.query(INBOX_PROBE_QUERY, { keys: teams, since }, InboxProbeData).pipe(
      Effect.map((data) => data.comments.nodes.length > 0),
      Effect.catch((error) =>
        Effect.logWarning("Linear inbox could not check for new comments.", { error }).pipe(
          Effect.as(false),
        ),
      ),
    );
  };

  const poll: LinearInbox["Service"]["poll"] = lock
    .withPermits(1)(
      Effect.gen(function* () {
        yield* releaseHeld();
        const session = yield* board.session;
        const catalog = yield* teamCatalog.snapshot;
        if (session !== null && catalog.source !== null) {
          const teams = [
            ...new Set(catalog.projects.flatMap((entry) => entry.project.linear?.team ?? [])),
          ];
          const known = teams.filter((team) => state.cursors[team] !== undefined);
          const startedAt = DateTime.formatIso(yield* DateTime.now);
          // A team seen for the first time starts now; old comments are not replayed.
          for (const team of teams) {
            if (state.cursors[team] === undefined) {
              state = { ...state, cursors: { ...state.cursors, [team]: startedAt } };
            }
          }
          if (known.length > 0 && (yield* anythingNew(session, known))) {
            const mapped = yield* board.linearProjects;
            for (const team of known) {
              yield* pollTeam(team, state.cursors[team]!, session, mapped).pipe(
                Effect.catch((error) =>
                  Effect.logWarning("Linear inbox could not read new comments.", { team, error }),
                ),
              );
            }
          }
        }
        const nowMs = (yield* DateTime.now).epochMilliseconds;
        state = {
          ...state,
          delivered: Object.fromEntries(
            Object.entries(state.delivered)
              .map(([threadId, times]) => [threadId, recentDeliveries(times, nowMs)] as const)
              .filter(([, times]) => times.length > 0),
          ),
        };
        log = [...prunedLog(log, nowMs)];
        publishLinearInboxLog(log);
        yield* saveState;
      }),
    )
    .pipe(Effect.withSpan("LinearInbox.poll"));

  const forward: LinearInbox["Service"]["forward"] = Effect.fn("LinearInbox.forward")(
    function* (input) {
      const check = yield* inboxForwardCheck(threads, input);
      if (check._tag === "refused") return yield* new LinearInboxRefusal({ detail: check.reason });
      const { entry, message, target } = check;
      const key = inboxMessageKey(target.id, entry.commentId);
      const result = yield* threads
        .sendToThread({
          projectId: target.projectId,
          commandId: CommandId.make(key),
          threadId: target.id,
          messageId: MessageId.make(key),
          ...(message.linkedSender === undefined ? {} : { linkedSender: message.linkedSender }),
          text: message.text,
          attachments: [],
          mode: "queue",
          createdBy: "agent",
          creationSource: "mcp",
        })
        .pipe(
          Effect.mapError(
            (error) =>
              new LinearInboxRefusal({ detail: `The message was not forwarded: ${error.message}` }),
          ),
        );
      const at = DateTime.formatIso(yield* DateTime.now);
      yield* lock.withPermits(1)(
        Effect.suspend(() => {
          countDelivery(target.id, at);
          record({
            ...entry,
            at,
            via: "forward",
            threadId: target.id,
            projectIds: [target.projectId],
          });
          return saveState;
        }),
      );
      return { threadId: target.id, messageId: MessageId.make(key), delivery: result.delivery };
    },
  );

  const reply: LinearInbox["Service"]["reply"] = Effect.fn("LinearInbox.reply")(function* (input) {
    const entry = deliveredTo(log, input.thread.id, input.commentId);
    if (entry === undefined) {
      return yield* new LinearInboxRefusal({
        detail: `Comment ${input.commentId} was not delivered to this thread, so it cannot be answered from here. Start a new message with board_message.`,
      });
    }
    return yield* board.reply({
      thread: input.thread,
      issueId: entry.issueId,
      issue: entry.issue,
      parentId: entry.rootId,
      text: input.text,
    });
  });

  yield* poll.pipe(Effect.delay(POLL_INTERVAL), Effect.forever, Effect.forkScoped);
  return LinearInbox.of({ poll, forward, reply });
});

export const layer = Layer.effect(LinearInbox, make);
