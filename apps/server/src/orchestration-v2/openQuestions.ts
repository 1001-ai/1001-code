import { QUESTION_WITHDRAWN_ANSWER, openQuestionCards } from "@t3tools/shared/questionCards";
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
  readonly id: string;
  readonly role: string;
  readonly text: string;
  readonly streaming: boolean;
  readonly createdAt: DateTime.Utc;
  readonly updatedAt: DateTime.Utc;
}

function oldestFirst<T extends QuestionCandidate>(messages: ReadonlyArray<T>): ReadonlyArray<T> {
  return messages.toSorted(
    (left, right) =>
      DateTime.toEpochMillis(left.createdAt) - DateTime.toEpochMillis(right.createdAt) ||
      (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
  );
}

/**
 * When the newest message that still holds an open card finished (cards exist only once their
 * message finishes), or null when every card is answered or withdrawn. The rule is the shared
 * `openQuestionCards`, which the Questions page runs too.
 */
function questionsAskedAt(oldestFirstCandidates: ReadonlyArray<QuestionCandidate>) {
  let newest: DateTime.Utc | null = null;
  for (const { message } of openQuestionCards(oldestFirstCandidates)) {
    if (newest === null || DateTime.isGreaterThan(message.updatedAt, newest)) {
      newest = message.updatedAt;
    }
  }
  return newest;
}

/** `questionsAskedAt` over a projection's messages, within the window the SQL reads. */
export function openQuestionsAt(messages: ReadonlyArray<QuestionCandidate>): DateTime.Utc | null {
  return questionsAskedAt(oldestFirst(messages).slice(-QUESTION_WINDOW));
}

const decodeCandidates = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Array(
      Schema.Struct({
        id: Schema.String,
        role: Schema.String,
        text: Schema.String,
        createdAt: Schema.DateTimeUtcFromString,
        updatedAt: Schema.DateTimeUtcFromString,
      }),
    ),
  ),
);

/** `questionsAskedAt` over the column `openQuestionCandidatesColumn` selects. */
export function openQuestionsAtFromCandidates(json: string | null): DateTime.Utc | null {
  if (json === null) return null;
  const candidates = Option.getOrElse(decodeCandidates(json), () => []);
  return questionsAskedAt(
    oldestFirst(candidates.map((candidate) => ({ ...candidate, streaming: false }))),
  );
}

/**
 * The finished messages in the window that may ask, withdraw or answer cards, as a JSON array;
 * the shared rule in `openQuestionsAtFromCandidates` decides. `instr` and `GLOB` keep only
 * assistant messages whose text can hold a card header or a withdraw line, and user messages
 * whose text can hold a `Qn:` answer line, so the rule sees every message that could change it.
 */
export function openQuestionCandidatesColumn(sql: SqlClient.SqlClient, threadId: string) {
  return sql`(
    SELECT json_group_array(json_object(
      'id', candidate.message_id,
      'role', candidate.role,
      'text', json_extract(candidate.payload_json, '$.text'),
      'createdAt', candidate.created_at,
      'updatedAt', candidate.updated_at
    ))
    FROM (
      SELECT recent.message_id, recent.role, recent.streaming, recent.payload_json,
        recent.created_at, recent.updated_at
      FROM orchestration_v2_projection_messages recent
      WHERE recent.thread_id = ${sql.literal(threadId)}
      ORDER BY recent.created_at DESC, recent.message_id DESC
      LIMIT ${sql.literal(String(QUESTION_WINDOW))}
    ) candidate
    WHERE candidate.streaming = 0
      AND (
        (
          candidate.role = 'assistant'
          AND (
            instr(candidate.payload_json, '**Q') > 0
            OR instr(candidate.payload_json, ${sql.literal(`'${QUESTION_WITHDRAWN_ANSWER}'`)}) > 0
          )
        )
        OR (candidate.role = 'user' AND candidate.payload_json GLOB '*Q[1-9]*')
      )
  )`;
}
