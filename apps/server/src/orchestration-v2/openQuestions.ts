import { questionCardsInMarkdown } from "@t3tools/shared/questionCards";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";

/**
 * Only a thread's newest messages can hold open questions. Both paths read the same window, the
 * newest by (created_at, message_id), so stored and live shells agree; the SQL walks its index.
 */
const QUESTION_WINDOW = 100;

interface QuestionCandidate {
  readonly role: string;
  readonly text: string;
  readonly streaming: boolean;
  readonly updatedAt: DateTime.Utc;
}

/**
 * When the newest assistant message that finished after the user's own latest message asked
 * question cards, or null. Cards exist once the message finishes, so a reply the user wrote into
 * mid-stream still asks. Any later message the user writes answers or passes on them; wakes do not.
 */
function questionsAskedAt(
  candidates: Iterable<QuestionCandidate>,
  latestUserAuthoredMessageAt: DateTime.Utc | null,
): DateTime.Utc | null {
  let newest: DateTime.Utc | null = null;
  for (const message of candidates) {
    if (message.role !== "assistant" || message.streaming) continue;
    if (
      latestUserAuthoredMessageAt !== null &&
      !DateTime.isGreaterThan(message.updatedAt, latestUserAuthoredMessageAt)
    ) {
      continue;
    }
    if (newest !== null && !DateTime.isGreaterThan(message.updatedAt, newest)) continue;
    if (questionCardsInMarkdown(message.text).length > 0) newest = message.updatedAt;
  }
  return newest;
}

/** `questionsAskedAt` over a projection's messages, within the window the SQL reads. */
export function openQuestionsAt(input: {
  readonly messages: ReadonlyArray<
    QuestionCandidate & { readonly id: string; readonly createdAt: DateTime.Utc }
  >;
  readonly latestUserAuthoredMessageAt: DateTime.Utc | null;
}): DateTime.Utc | null {
  const newestFirst = input.messages.toSorted(
    (left, right) =>
      DateTime.toEpochMillis(right.createdAt) - DateTime.toEpochMillis(left.createdAt) ||
      (left.id < right.id ? 1 : left.id > right.id ? -1 : 0),
  );
  return questionsAskedAt(newestFirst.slice(0, QUESTION_WINDOW), input.latestUserAuthoredMessageAt);
}

const decodeCandidates = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Array(
      Schema.Struct({
        text: Schema.String,
        updatedAt: Schema.DateTimeUtcFromString,
      }),
    ),
  ),
);

/** `questionsAskedAt` over the column `openQuestionCandidatesColumn` selects. */
export function openQuestionsAtFromCandidates(
  json: string | null,
  latestUserAuthoredMessageAt: DateTime.Utc | null,
): DateTime.Utc | null {
  if (json === null) return null;
  const candidates = Option.getOrElse(decodeCandidates(json), () => []);
  return questionsAskedAt(
    candidates.map((candidate) => ({ ...candidate, role: "assistant", streaming: false })),
    latestUserAuthoredMessageAt,
  );
}

/**
 * The finished assistant messages in the window that may hold cards, as a JSON array; the shared
 * predicate in `openQuestionsAtFromCandidates` decides. `instr` keeps only messages whose text can
 * contain a card header, so the predicate sees every message it would accept.
 */
export function openQuestionCandidatesColumn(sql: SqlClient.SqlClient, threadId: string) {
  return sql`(
    SELECT json_group_array(json_object(
      'text', json_extract(candidate.payload_json, '$.text'),
      'updatedAt', candidate.updated_at
    ))
    FROM (
      SELECT recent.role, recent.streaming, recent.payload_json, recent.updated_at
      FROM orchestration_v2_projection_messages recent
      WHERE recent.thread_id = ${sql.literal(threadId)}
      ORDER BY recent.created_at DESC, recent.message_id DESC
      LIMIT ${sql.literal(String(QUESTION_WINDOW))}
    ) candidate
    WHERE candidate.role = 'assistant'
      AND candidate.streaming = 0
      AND instr(candidate.payload_json, '**Q') > 0
  )`;
}
