import { ScheduledTaskId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";

/** The shell's field when a scheduled task started the thread; no field for any other thread. */
export interface StartedByScheduledTask {
  readonly startedByScheduledTaskId?: ScheduledTaskId;
}

interface FirstMessageCandidate {
  readonly id: string;
  readonly createdAt: DateTime.Utc;
  readonly scheduledTaskId?: ScheduledTaskId | undefined;
}

const NOT_STARTED_BY_TASK: StartedByScheduledTask = {};
const decodeScheduledTaskId = Schema.decodeUnknownOption(ScheduledTaskId);

/** The field for the value `startedByScheduledTaskIdColumn` selects. */
export function startedByScheduledTaskFromColumn(value: string | null): StartedByScheduledTask {
  return Option.match(decodeScheduledTaskId(value), {
    onNone: () => NOT_STARTED_BY_TASK,
    onSome: (startedByScheduledTaskId) => ({ startedByScheduledTaskId }),
  });
}

/**
 * The scheduled task whose prompt is the thread's first message, by (created_at, message_id): the
 * row `startedByScheduledTaskIdColumn` reads, so stored and live shells agree. A task that posts
 * into a thread a person started is not its starter.
 */
export function startedByScheduledTask(
  messages: ReadonlyArray<FirstMessageCandidate>,
): StartedByScheduledTask {
  let first: FirstMessageCandidate | undefined;
  for (const message of messages) {
    if (first === undefined) {
      first = message;
      continue;
    }
    const order =
      DateTime.toEpochMillis(message.createdAt) - DateTime.toEpochMillis(first.createdAt);
    if (order < 0 || (order === 0 && message.id < first.id)) first = message;
  }
  return startedByScheduledTaskFromColumn(first?.scheduledTaskId ?? null);
}

/** The first message's `scheduledTaskId`: one seek on the (thread_id, created_at, message_id) index. */
export function startedByScheduledTaskIdColumn(sql: SqlClient.SqlClient, threadId: string) {
  return sql`(
    SELECT json_extract(first_message.payload_json, '$.scheduledTaskId')
    FROM orchestration_v2_projection_messages first_message
    WHERE first_message.thread_id = ${sql.literal(threadId)}
    ORDER BY first_message.created_at ASC, first_message.message_id ASC
    LIMIT 1
  )`;
}
