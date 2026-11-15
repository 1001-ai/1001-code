import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as TeamCatalog from "../teamCatalog/TeamCatalog.ts";
import * as Board from "./Board.ts";
import {
  type CommentRoute,
  INBOX_PAGE_SIZE,
  INBOX_QUERY,
  InboxData,
  type LinearComment,
  MAX_INBOX_PAGES,
  routeComment,
  threadSkipReason,
} from "./linearInboxRouting.ts";

/**
 * Reads new comments on the catalog's Linear teams every 30 seconds while someone is signed in to
 * the board, and works out which local thread each is for. This step only logs that decision;
 * nothing is delivered into threads yet.
 */
export class LinearInbox extends Context.Service<
  LinearInbox,
  {
    /** One pass over every team; the layer runs it every 30 seconds. */
    readonly poll: Effect.Effect<void>;
  }
>()("t3/board/LinearInbox") {}

const POLL_INTERVAL = Duration.seconds(30);

/** Per team key, the creation time of the newest comment already read. */
const CursorFile = Schema.fromJsonString(Schema.Record(Schema.String, Schema.String));
const decodeCursorFile = Schema.decodeUnknownOption(CursorFile);
const encodeCursorFile = Schema.encodeSync(CursorFile);

const make = Effect.gen(function* () {
  const board = yield* Board.Board;
  const teamCatalog = yield* TeamCatalog.TeamCatalog;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const instances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const environmentId = yield* (yield* ServerEnvironment.ServerEnvironment).getEnvironmentId;
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const cursorPath = path.join(config.stateDir, "linear-inbox.json");
  const stored = yield* fileSystem
    .readFileString(cursorPath)
    .pipe(Effect.map(decodeCursorFile), Effect.orElseSucceed(Option.none));
  const cursors = new Map(Object.entries(Option.getOrElse(stored, () => ({}))));
  const saveCursors = Effect.suspend(() =>
    fileSystem.writeFileString(cursorPath, encodeCursorFile(Object.fromEntries(cursors))),
  ).pipe(
    Effect.catch((cause) => Effect.logWarning("Linear inbox could not save its cursor.", cause)),
  );

  const logRoute = Effect.fnUntraced(function* (
    comment: LinearComment,
    route: CommentRoute,
    nowMs: number,
  ) {
    const fields = { comment: comment.id, issue: comment.issue?.identifier ?? null };
    if (route._tag === "skip") {
      return yield* Effect.logDebug("Linear inbox skips a comment.", {
        ...fields,
        reason: route.reason,
      });
    }
    const thread = yield* orchestrator.getThreadShell(route.threadId);
    const instance =
      thread === null ? undefined : yield* instances.getInstance(thread.providerInstanceId);
    const reason = threadSkipReason(thread, instance?.driverKind, nowMs);
    if (reason !== null) {
      return yield* Effect.logInfo("Linear inbox skips a comment for a thread.", {
        ...fields,
        threadId: route.threadId,
        reason,
      });
    }
    yield* Effect.logInfo("Linear inbox would deliver a comment.", {
      ...fields,
      threadId: route.threadId,
      kind: route.kind,
      sender: route.sender,
    });
  });

  const pollTeam = Effect.fn("LinearInbox.pollTeam")(function* (team: string, viewerId: string) {
    const now = yield* DateTime.now;
    const since = cursors.get(team);
    // A team seen for the first time starts now; old comments are not replayed.
    if (since === undefined) {
      cursors.set(team, DateTime.formatIso(now));
      return yield* saveCursors;
    }
    // Linear lists newest first, so the cursor may move only after every page is read.
    const pages: Array<InboxData> = [];
    let after: string | null = null;
    for (let page = 0; page < MAX_INBOX_PAGES; page += 1) {
      const data: InboxData = yield* board.query(
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
      const route = routeComment(comment, { viewerId, environmentId, memberIds });
      yield* logRoute(comment, route, now.epochMilliseconds);
    }
    const newest = comments.at(-1)?.createdAt;
    if (newest !== undefined) {
      cursors.set(team, newest);
      yield* saveCursors;
    }
  });

  const poll: LinearInbox["Service"]["poll"] = Effect.gen(function* () {
    const connection = yield* board.connection;
    if (connection.status !== "connected") return;
    const catalog = yield* teamCatalog.snapshot;
    if (catalog.source === null) return;
    const teams = new Set(catalog.projects.flatMap((entry) => entry.project.linear?.team ?? []));
    for (const team of teams) {
      yield* pollTeam(team, connection.viewer.id).pipe(
        Effect.catch((error) =>
          Effect.logWarning("Linear inbox could not read new comments.", { team, error }),
        ),
      );
    }
  }).pipe(Effect.withSpan("LinearInbox.poll"));

  yield* poll.pipe(Effect.delay(POLL_INTERVAL), Effect.forever, Effect.forkScoped);
  return LinearInbox.of({ poll });
});

export const layer = Layer.effect(LinearInbox, make);
