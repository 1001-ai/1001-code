import {
  CommandId,
  EnvironmentId,
  MessageId,
  OrchestrationV2LinkedSender,
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

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as TeamCatalog from "../teamCatalog/TeamCatalog.ts";
import * as Board from "./Board.ts";
import {
  DAILY_THREAD_LIMIT,
  INBOX_PAGE_SIZE,
  INBOX_QUERY,
  InboxData,
  type LinearComment,
  MAX_INBOX_PAGES,
  exchangeSkipReason,
  framedComment,
  recentDeliveries,
  routeComment,
  senderThread,
  threadSkipReason,
} from "./linearInboxRouting.ts";

/**
 * Delivers teammates' comments on the catalog's Linear teams into the local thread linked to each
 * issue, read every 30 seconds while someone is signed in to the board. A comment starts a turn
 * like any queued message, except in a full-access thread: there it waits until the user sends
 * something in that thread or lowers its mode, so a teammate never starts full-access work alone.
 */
export class LinearInbox extends Context.Service<
  LinearInbox,
  {
    /** One pass: held comments, then every team; the layer runs it every 30 seconds. */
    readonly poll: Effect.Effect<void>;
  }
>()("t3/board/LinearInbox") {}

const POLL_INTERVAL = Duration.seconds(30);

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
    /** Comments waiting for the user in a full-access thread, with when they arrived. */
    held: Schema.Array(Schema.Struct({ ...Delivery.fields, since: Schema.String })),
  }),
);
type InboxState = typeof InboxState.Type;
const decodeState = Schema.decodeUnknownOption(InboxState);
const encodeState = Schema.encodeSync(InboxState);

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

  const statePath = path.join(config.stateDir, "linear-inbox.json");
  const stored = yield* fileSystem
    .readFileString(statePath)
    .pipe(Effect.map(decodeState), Effect.orElseSucceed(Option.none));
  let state: InboxState = Option.getOrElse(stored, () => ({
    cursors: {},
    delivered: {},
    held: [],
  }));
  const saveState = Effect.suspend(() =>
    fileSystem.writeFileString(statePath, encodeState(state)),
  ).pipe(
    Effect.catch((cause) => Effect.logWarning("Linear inbox could not save its state.", cause)),
  );

  const deliver = Effect.fn("LinearInbox.deliver")(function* (delivery: Delivery) {
    const key = `linear-inbox:${delivery.threadId}:${delivery.commentId}`;
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
    const now = DateTime.formatIso(yield* DateTime.now);
    state = {
      ...state,
      delivered: {
        ...state.delivered,
        [delivery.threadId]: [...(state.delivered[delivery.threadId] ?? []), now],
      },
    };
    yield* Effect.logInfo("Linear inbox delivered a comment.", {
      comment: delivery.commentId,
      threadId: delivery.threadId,
      delivery: result.delivery,
    });
  });

  /** Held comments go in once the user is back in the thread or it left full access. */
  const releaseHeld = Effect.fn("LinearInbox.releaseHeld")(function* () {
    const kept: Array<InboxState["held"][number]> = [];
    for (const item of state.held) {
      const thread = yield* threads
        .getThreadShell(item.threadId)
        .pipe(Effect.orElseSucceed(() => null));
      if (thread === null || thread.archivedAt !== null) continue;
      const userSentSince =
        thread.latestUserAuthoredMessageAt != null &&
        thread.latestUserAuthoredMessageAt.epochMilliseconds > Date.parse(item.since);
      if (thread.runtimeMode === "full-access" && !userSentSince) {
        kept.push(item);
        continue;
      }
      yield* deliver(item).pipe(
        Effect.catch((error) =>
          Effect.logWarning("Linear inbox could not deliver a held comment.", {
            comment: item.commentId,
            error,
          }),
        ),
      );
    }
    state = { ...state, held: kept };
  });

  const handleComment = Effect.fnUntraced(function* (
    comment: LinearComment,
    viewerId: string,
    memberIds: ReadonlySet<string>,
    now: DateTime.Utc,
  ) {
    const nowMs = now.epochMilliseconds;
    const fields = { comment: comment.id, issue: comment.issue?.identifier ?? null };
    const route = routeComment(comment, { viewerId, environmentId, memberIds });
    if (route._tag === "skip") {
      return yield* Effect.logDebug("Linear inbox skips a comment.", {
        ...fields,
        reason: route.reason,
      });
    }
    const thread = yield* threads
      .getThreadShell(route.threadId)
      .pipe(Effect.orElseSucceed(() => null));
    const instance =
      thread === null ? undefined : yield* instances.getInstance(thread.providerInstanceId);
    const waiting =
      recentDeliveries(state.delivered[route.threadId] ?? [], nowMs).length +
      state.held.filter((item) => item.threadId === route.threadId).length;
    const reason =
      threadSkipReason(thread, instance?.driverKind, nowMs) ??
      exchangeSkipReason(comment, memberIds) ??
      (waiting >= DAILY_THREAD_LIMIT ? "daily-limit" : null);
    if (thread === null || reason !== null) {
      return yield* Effect.logInfo("Linear inbox skips a comment for a thread.", {
        ...fields,
        threadId: route.threadId,
        reason,
      });
    }
    const title = route.kind === "agent" ? `${route.sender}'s agent` : route.sender;
    const delivery: Delivery = {
      threadId: route.threadId,
      projectId: thread.projectId,
      commentId: comment.id,
      text: framedComment({
        body: comment.body,
        issue: comment.issue?.identifier ?? "a Linear issue",
        sender: route.sender,
        kind: route.kind,
        nonce: Hex.encode(yield* random.randomBytes(4)),
      }),
      linkedSender: {
        ...(senderThread(comment.body) ?? {
          environmentId: LINEAR_ENVIRONMENT,
          threadId: ThreadId.make(`linear-comment-${comment.id}`),
        }),
        title,
      },
    };
    if (thread.runtimeMode === "full-access") {
      state = {
        ...state,
        held: [...state.held, { ...delivery, since: DateTime.formatIso(now) }],
      };
      return yield* Effect.logInfo("Linear inbox holds a comment for a full-access thread.", {
        ...fields,
        threadId: route.threadId,
      });
    }
    yield* deliver(delivery).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Linear inbox could not deliver a comment.", { ...fields, error }),
      ),
    );
  });

  const pollTeam = Effect.fn("LinearInbox.pollTeam")(function* (
    team: string,
    session: Board.BoardLinearSession,
  ) {
    const now = yield* DateTime.now;
    const since = state.cursors[team];
    // A team seen for the first time starts now; old comments are not replayed.
    if (since === undefined) {
      state = { ...state, cursors: { ...state.cursors, [team]: DateTime.formatIso(now) } };
      return;
    }
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
      yield* handleComment(comment, session.viewerId, memberIds, now);
    }
    const newest = comments.at(-1)?.createdAt;
    if (newest !== undefined) state = { ...state, cursors: { ...state.cursors, [team]: newest } };
  });

  const poll: LinearInbox["Service"]["poll"] = Effect.gen(function* () {
    yield* releaseHeld();
    const session = yield* board.session;
    const catalog = yield* teamCatalog.snapshot;
    if (session !== null && catalog.source !== null) {
      const teams = new Set(catalog.projects.flatMap((entry) => entry.project.linear?.team ?? []));
      for (const team of teams) {
        yield* pollTeam(team, session).pipe(
          Effect.catch((error) =>
            Effect.logWarning("Linear inbox could not read new comments.", { team, error }),
          ),
        );
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
    yield* saveState;
  }).pipe(Effect.withSpan("LinearInbox.poll"));

  yield* poll.pipe(Effect.delay(POLL_INTERVAL), Effect.forever, Effect.forkScoped);
  return LinearInbox.of({ poll });
});

export const layer = Layer.effect(LinearInbox, make);
