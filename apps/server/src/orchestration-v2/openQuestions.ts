import { questionCardsInMarkdown } from "@t3tools/shared/questionCards";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";

interface QuestionCandidate {
  readonly role: string;
  readonly text: string;
  readonly streaming: boolean;
  readonly createdAt: DateTime.Utc;
  readonly updatedAt: DateTime.Utc;
}

/**
 * When the newest finished assistant message since the user's own latest message asked question
 * cards, or null. Any later message the user writes answers or passes on them; wakes do not.
 */
export function openQuestionsAt(input: {
  readonly messages: Iterable<QuestionCandidate>;
  readonly latestUserAuthoredMessageAt: DateTime.Utc | null;
}): DateTime.Utc | null {
  let newest: DateTime.Utc | null = null;
  for (const message of input.messages) {
    if (message.role !== "assistant" || message.streaming) continue;
    if (
      input.latestUserAuthoredMessageAt !== null &&
      !DateTime.isGreaterThan(message.createdAt, input.latestUserAuthoredMessageAt)
    ) {
      continue;
    }
    if (newest !== null && !DateTime.isGreaterThan(message.updatedAt, newest)) continue;
    if (questionCardsInMarkdown(message.text).length > 0) newest = message.updatedAt;
  }
  return newest;
}

const decodeCandidates = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Array(
      Schema.Struct({
        text: Schema.String,
        createdAt: Schema.DateTimeUtcFromString,
        updatedAt: Schema.DateTimeUtcFromString,
      }),
    ),
  ),
);

/** `openQuestionsAt` over the column `openQuestionCandidatesColumn` selects. */
export function openQuestionsAtFromCandidates(
  json: string | null,
  latestUserAuthoredMessageAt: DateTime.Utc | null,
): DateTime.Utc | null {
  if (json === null) return null;
  const candidates = Option.getOrElse(decodeCandidates(json), () => []);
  return openQuestionsAt({
    messages: candidates.map((candidate) => ({
      ...candidate,
      role: "assistant",
      streaming: false,
    })),
    latestUserAuthoredMessageAt,
  });
}

/**
 * Finished assistant messages since the thread's latest user-authored one that may hold cards, as a
 * JSON array. Both scans walk the (thread_id, created_at) index from the newest message, so a
 * thread costs only its messages since the user last wrote.
 */
export function openQuestionCandidatesColumn(sql: SqlClient.SqlClient, threadId: string) {
  const thread = sql.literal(threadId);
  return sql`(
    SELECT json_group_array(json_object(
      'text', json_extract(candidate.payload_json, '$.text'),
      'createdAt', candidate.created_at,
      'updatedAt', candidate.updated_at
    ))
    FROM orchestration_v2_projection_messages candidate
    WHERE candidate.thread_id = ${thread}
      AND candidate.role = 'assistant'
      AND candidate.streaming = 0
      AND instr(candidate.payload_json, '**Q') > 0
      AND candidate.created_at > coalesce((
        SELECT authored.created_at
        FROM orchestration_v2_projection_messages authored
        WHERE authored.thread_id = ${thread}
          AND authored.role = 'user'
          AND json_extract(authored.payload_json, '$.createdBy') = 'user'
        ORDER BY authored.created_at DESC, authored.message_id DESC
        LIMIT 1
      ), '')
  )`;
}
