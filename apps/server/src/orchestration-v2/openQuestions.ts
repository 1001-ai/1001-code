import {
  QUESTION_WITHDRAWN_ANSWER,
  questionCardsInMarkdown,
  questionWithdrawalsInMarkdown,
} from "@t3tools/shared/questionCards";
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

function newestFirst<T extends QuestionCandidate>(messages: ReadonlyArray<T>): ReadonlyArray<T> {
  return messages.toSorted(
    (left, right) =>
      DateTime.toEpochMillis(right.createdAt) - DateTime.toEpochMillis(left.createdAt) ||
      (left.id < right.id ? 1 : left.id > right.id ? -1 : 0),
  );
}

/**
 * When the newest assistant message that finished after the user's own latest message asked cards
 * it has not since withdrawn (a reply written mid-stream still asks; wakes don't answer), or null.
 * A `Qn: no longer needed` line withdraws a card of the newest earlier message that asks cards.
 */
function questionsAskedAt(
  newestFirstCandidates: Iterable<QuestionCandidate>,
  latestUserAuthoredMessageAt: DateTime.Utc | null,
): DateTime.Utc | null {
  let newest: DateTime.Utc | null = null;
  // Ids that newer messages withdrew, waiting for the next older message that asks cards.
  let withdrawn = new Set<string>();
  for (const message of newestFirstCandidates) {
    if (message.role !== "assistant" || message.streaming) continue;
    const withdrawals = questionWithdrawalsInMarkdown(message.text);
    const cards = questionCardsInMarkdown(message.text);
    if (cards.length === 0) {
      for (const id of withdrawals) withdrawn.add(id);
      continue;
    }
    const open = cards.some((card) => !withdrawn.has(card.id));
    withdrawn = new Set(withdrawals);
    if (!open) continue;
    if (
      latestUserAuthoredMessageAt !== null &&
      !DateTime.isGreaterThan(message.updatedAt, latestUserAuthoredMessageAt)
    ) {
      continue;
    }
    if (newest === null || DateTime.isGreaterThan(message.updatedAt, newest)) {
      newest = message.updatedAt;
    }
  }
  return newest;
}

/** `questionsAskedAt` over a projection's messages, within the window the SQL reads. */
export function openQuestionsAt(input: {
  readonly messages: ReadonlyArray<QuestionCandidate>;
  readonly latestUserAuthoredMessageAt: DateTime.Utc | null;
}): DateTime.Utc | null {
  return questionsAskedAt(
    newestFirst(input.messages).slice(0, QUESTION_WINDOW),
    input.latestUserAuthoredMessageAt,
  );
}

const decodeCandidates = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Array(
      Schema.Struct({
        id: Schema.String,
        text: Schema.String,
        createdAt: Schema.DateTimeUtcFromString,
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
    newestFirst(
      candidates.map((candidate) => ({ ...candidate, role: "assistant", streaming: false })),
    ),
    latestUserAuthoredMessageAt,
  );
}

/**
 * The finished assistant messages in the window that may ask or withdraw cards, as a JSON array;
 * the shared predicate in `openQuestionsAtFromCandidates` decides. `instr` keeps only messages
 * whose text can contain a card header or a withdraw line, so the predicate sees every message
 * that could change its answer.
 */
export function openQuestionCandidatesColumn(sql: SqlClient.SqlClient, threadId: string) {
  return sql`(
    SELECT json_group_array(json_object(
      'id', candidate.message_id,
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
    WHERE candidate.role = 'assistant'
      AND candidate.streaming = 0
      AND (
        instr(candidate.payload_json, '**Q') > 0
        OR instr(candidate.payload_json, ${sql.literal(`'${QUESTION_WITHDRAWN_ANSWER}'`)}) > 0
      )
  )`;
}
