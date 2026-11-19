import { type BoardError, OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as Board from "../../../board/Board.ts";
import * as LinearInbox from "../../../board/LinearInbox.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { loadCaller } from "../../threadAccess.ts";
import { BoardToolkit } from "./tools.ts";

/** The calling thread; the board is its project's. */
const callingThread = loadCaller().pipe(
  Effect.flatMap(({ caller }) =>
    caller === undefined
      ? Effect.fail(
          new OrchestratorMcpFailure({
            code: "thread_credential_required",
            message: "Only an agent in a thread can use its project's board.",
          }),
        )
      : Effect.succeed(caller),
  ),
);

/** A refused input is the agent's to fix; anything else is Linear or the sign-in. */
const toMcpFailure = (error: Board.BoardInputError | BoardError) =>
  new OrchestratorMcpFailure({
    code: error._tag === "BoardInputError" ? "invalid_request" : "orchestration_error",
    message: error.detail,
  });

const handlers = {
  board_add: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const caller = yield* callingThread;
      const board = yield* Board.Board;
      return yield* board
        .addTask({
          projectId: caller.projectId,
          thread: { id: caller.id, title: caller.title },
          ...input,
        })
        .pipe(Effect.mapError(toMcpFailure));
    }),
  ),
  board_update: McpToolAccess.actsAsCaller(({ task, ...fields }) =>
    Effect.gen(function* () {
      const caller = yield* callingThread;
      const board = yield* Board.Board;
      return yield* board
        .updateTask({
          projectId: caller.projectId,
          thread: { id: caller.id, title: caller.title },
          identifier: task,
          ...fields,
        })
        .pipe(Effect.mapError(toMcpFailure));
    }),
  ),
  board_list: McpToolAccess.readsAsCaller(() =>
    Effect.gen(function* () {
      const caller = yield* callingThread;
      const board = yield* Board.Board;
      return yield* board.listTasks(caller.projectId).pipe(Effect.mapError(toMcpFailure));
    }),
  ),
  board_message: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const caller = yield* callingThread;
      const board = yield* Board.Board;
      return yield* board
        .message({
          projectId: caller.projectId,
          thread: { id: caller.id, title: caller.title },
          ...input,
        })
        .pipe(Effect.mapError(toMcpFailure));
    }),
  ),
  board_reply: McpToolAccess.actsAsCaller(({ commentId, text }) =>
    Effect.gen(function* () {
      const caller = yield* callingThread;
      const inbox = yield* LinearInbox.LinearInbox;
      return yield* inbox
        .reply({ thread: { id: caller.id, title: caller.title }, commentId, text })
        .pipe(
          Effect.mapError((error) =>
            error._tag === "LinearInboxRefusal"
              ? new OrchestratorMcpFailure({ code: "invalid_request", message: error.detail })
              : toMcpFailure(error),
          ),
        );
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof BoardToolkit.tools>;

export const layer = McpToolAccess.toLayer(BoardToolkit, handlers);
