import { type MessageId, type ThreadId, ThreadPullRequestLink } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import type {
  MomentMessage,
  MomentRun,
  MomentRuntimeRequest,
  MomentThread,
  MomentToolItem,
} from "./projectMoments.logic.ts";

// Reads only the projection tables and their indexes; payloads are read with json_extract so a
// page never decodes whole messages or turn items.

export interface ThreadRow extends MomentThread {
  readonly projectId: string;
  readonly deleted: boolean;
  readonly pullRequests: ReadonlyArray<ThreadPullRequestLink>;
}

const decodePullRequests = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Array(ThreadPullRequestLink)),
);

interface RawThreadRow {
  readonly thread_id: string;
  readonly project_id: string;
  readonly title: string;
  readonly deleted_at: string | null;
  readonly relationship: string | null;
  readonly side_chat: number | null;
  readonly voice_agent: number | null;
  readonly delegated: number;
  readonly pull_requests: string | null;
}

const threadRow = (row: RawThreadRow): ThreadRow => ({
  threadId: row.thread_id as ThreadId,
  projectId: row.project_id,
  title: row.title,
  deleted: row.deleted_at !== null,
  relationshipToParent: row.relationship,
  sideChat: row.side_chat === 1,
  voiceAgent: row.voice_agent === 1,
  delegated: row.delegated === 1,
  pullRequests:
    row.pull_requests === null
      ? []
      : Option.getOrElse(decodePullRequests(row.pull_requests), () => []),
});

const threadColumns = (sql: SqlClient.SqlClient) => sql`
  thread_id,
  project_id,
  title,
  deleted_at,
  json_extract(payload_json, '$.lineage.relationshipToParent') AS relationship,
  json_extract(payload_json, '$.lineage.sideChat') AS side_chat,
  json_extract(payload_json, '$.lineage.voiceAgent') AS voice_agent,
  (json_type(payload_json, '$.delegatedFrom') = 'object') AS delegated,
  json_extract(payload_json, '$.pullRequests') AS pull_requests
`;

export const projectThreads = Effect.fn("ProjectMoments.projectThreads")(function* (
  projectId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<RawThreadRow>`
    SELECT ${threadColumns(sql)}
    FROM orchestration_v2_projection_threads
    WHERE project_id = ${projectId} AND deleted_at IS NULL
  `;
  return rows.map(threadRow);
});

export const threadById = Effect.fn("ProjectMoments.threadById")(function* (threadId: string) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<RawThreadRow>`
    SELECT ${threadColumns(sql)}
    FROM orchestration_v2_projection_threads
    WHERE thread_id = ${threadId}
  `;
  return rows[0] === undefined ? null : threadRow(rows[0]);
});

export const threadTitles = Effect.fn("ProjectMoments.threadTitles")(function* (
  threadIds: ReadonlyArray<string>,
) {
  if (threadIds.length === 0) return new Map<string, string>();
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly thread_id: string; readonly title: string }>`
    SELECT thread_id, title FROM orchestration_v2_projection_threads
    WHERE thread_id IN ${sql.in(threadIds)}
  `;
  return new Map(rows.map((row) => [row.thread_id, row.title]));
});

interface RawMessageRow {
  readonly message_id: string;
  readonly thread_id: string;
  readonly role: string;
  readonly streaming: number;
  readonly created_at: string;
  readonly updated_at: string;
  readonly text: string | null;
  readonly created_by: string | null;
  readonly scheduled_task_id: string | null;
  readonly sender_thread_id: string | null;
  readonly linked_sender_title: string | null;
  readonly internal: number;
  readonly notification: number;
}

/**
 * Prompts, and finished assistant messages that may hold question cards (the same `instr`
 * prefilter the shell's open-questions column uses), created at or after `since`.
 */
export const recentMessages = Effect.fn("ProjectMoments.recentMessages")(function* (
  threadIds: ReadonlyArray<string>,
  since: string,
) {
  if (threadIds.length === 0) return [];
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<RawMessageRow>`
    SELECT
      message_id,
      thread_id,
      role,
      streaming,
      created_at,
      updated_at,
      CASE WHEN role = 'user'
        THEN substr(json_extract(payload_json, '$.text'), 1, 400)
        ELSE json_extract(payload_json, '$.text')
      END AS text,
      json_extract(payload_json, '$.createdBy') AS created_by,
      json_extract(payload_json, '$.scheduledTaskId') AS scheduled_task_id,
      json_extract(payload_json, '$.senderThreadId') AS sender_thread_id,
      json_extract(payload_json, '$.linkedSender.title') AS linked_sender_title,
      (
        json_extract(payload_json, '$.idleCompaction') IS NOT NULL
        OR json_type(payload_json, '$.delegatedCompletion') = 'object'
        OR json_extract(payload_json, '$.workflowScript') IS 1
      ) AS internal,
      (json_type(payload_json, '$.notification') = 'object') AS notification
    FROM orchestration_v2_projection_messages
    WHERE thread_id IN ${sql.in(threadIds)}
      AND created_at >= ${since}
      AND (
        role = 'user'
        OR (role = 'assistant' AND streaming = 0 AND instr(payload_json, '**Q') > 0)
      )
  `;
  return rows.map((row): MomentMessage => ({
    id: row.message_id as MessageId,
    threadId: row.thread_id as ThreadId,
    role: row.role,
    streaming: row.streaming === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    text: row.text ?? "",
    createdBy: row.created_by,
    scheduledTaskId: row.scheduled_task_id,
    senderThreadId: row.sender_thread_id as ThreadId | null,
    linkedSenderTitle: row.linked_sender_title,
    internal: row.internal === 1,
    notification: row.notification === 1,
  }));
});

export const pendingRuntimeRequests = Effect.fn("ProjectMoments.pendingRuntimeRequests")(function* (
  threadIds: ReadonlyArray<string>,
  since: string,
) {
  if (threadIds.length === 0) return [];
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    readonly runtime_request_id: string;
    readonly thread_id: string;
    readonly kind: string;
    readonly status: string;
    readonly created_at: string;
  }>`
      SELECT runtime_request_id, thread_id, kind, status, created_at
      FROM orchestration_v2_projection_runtime_requests
      WHERE thread_id IN ${sql.in(threadIds)}
        AND status = 'pending'
        AND kind = 'user_input'
        AND created_at >= ${since}
    `;
  return rows.map((row): MomentRuntimeRequest => ({
    id: row.runtime_request_id,
    threadId: row.thread_id as ThreadId,
    kind: row.kind,
    status: row.status,
    createdAt: row.created_at,
  }));
});

interface RawRunRow {
  readonly run_id: string;
  readonly thread_id: string;
  readonly status: string;
  readonly completed_at: string | null;
  readonly prompt_id: string | null;
  readonly source_kind: string | null;
  readonly source_work: string | null;
  readonly outcome: string | null;
  readonly delegated_completion: number | null;
  readonly idle_compaction: number | null;
  readonly user_steered: number;
  readonly last_assistant_id: string | null;
  readonly last_assistant_text: string | null;
}

const runRow = (row: RawRunRow): MomentRun => ({
  runId: row.run_id,
  threadId: row.thread_id as ThreadId,
  status: row.status,
  completedAt: row.completed_at,
  prompt:
    row.prompt_id === null
      ? null
      : {
          notificationSourceKind: row.source_kind,
          notificationSourceWork: row.source_work,
          notificationOutcome: row.outcome,
          delegatedCompletion: row.delegated_completion === 1,
          idleCompaction: row.idle_compaction === 1,
        },
  userSteered: row.user_steered === 1,
  lastAssistant:
    row.last_assistant_id === null
      ? null
      : { id: row.last_assistant_id as MessageId, text: row.last_assistant_text ?? "" },
});

const runSelect = (sql: SqlClient.SqlClient) => sql`
  SELECT
    run.run_id,
    run.thread_id,
    run.status,
    run.completed_at,
    prompt.message_id AS prompt_id,
    json_extract(prompt.payload_json, '$.notification.source.kind') AS source_kind,
    json_extract(prompt.payload_json, '$.notification.source.work') AS source_work,
    json_extract(prompt.payload_json, '$.notification.outcome') AS outcome,
    (json_type(prompt.payload_json, '$.delegatedCompletion') = 'object') AS delegated_completion,
    (json_extract(prompt.payload_json, '$.idleCompaction') IS NOT NULL) AS idle_compaction,
    EXISTS (
      SELECT 1 FROM orchestration_v2_projection_messages steer
      WHERE steer.run_id = run.run_id
        AND json_extract(steer.payload_json, '$.createdBy') = 'user'
    ) AS user_steered,
    last.message_id AS last_assistant_id,
    substr(json_extract(last.payload_json, '$.text'), 1, 400) AS last_assistant_text
  FROM orchestration_v2_projection_runs run
  LEFT JOIN orchestration_v2_projection_messages prompt
    ON prompt.message_id = json_extract(run.payload_json, '$.userMessageId')
  LEFT JOIN orchestration_v2_projection_messages last
    ON last.message_id = (
      SELECT candidate.message_id FROM orchestration_v2_projection_messages candidate
      WHERE candidate.run_id = run.run_id AND candidate.role = 'assistant'
      ORDER BY candidate.created_at DESC, candidate.message_id DESC
      LIMIT 1
    )
`;

export const completedRuns = Effect.fn("ProjectMoments.completedRuns")(function* (
  threadIds: ReadonlyArray<string>,
  since: string,
) {
  if (threadIds.length === 0) return [];
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<RawRunRow>`
    ${runSelect(sql)}
    WHERE run.thread_id IN ${sql.in(threadIds)}
      AND run.status = 'completed'
      AND run.completed_at >= ${since}
  `;
  return rows.map(runRow);
});

export const runById = Effect.fn("ProjectMoments.runById")(function* (runId: string) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<RawRunRow>`${runSelect(sql)} WHERE run.run_id = ${runId}`;
  return rows[0] === undefined ? null : runRow(rows[0]);
});

/** Finished T3 tool calls that may be a `t3_thread_send`; the logic checks the name and target. */
export const threadSendItems = Effect.fn("ProjectMoments.threadSendItems")(function* (
  threadIds: ReadonlyArray<string>,
  since: string,
) {
  if (threadIds.length === 0) return [];
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    readonly turn_item_id: string;
    readonly thread_id: string;
    readonly type: string;
    readonly status: string;
    readonly updated_at: string;
    readonly tool_name: string | null;
    readonly input: string | null;
  }>`
    SELECT
      turn_item_id,
      thread_id,
      type,
      status,
      updated_at,
      json_extract(payload_json, '$.toolName') AS tool_name,
      json_extract(payload_json, '$.input') AS input
    FROM orchestration_v2_projection_turn_items
    WHERE thread_id IN ${sql.in(threadIds)}
      AND type = 'dynamic_tool'
      AND status = 'completed'
      AND updated_at >= ${since}
      AND instr(payload_json, 'thread_send') > 0
  `;
  return rows.map((row): MomentToolItem => ({
    id: row.turn_item_id,
    threadId: row.thread_id as ThreadId,
    type: row.type,
    status: row.status,
    toolName: row.tool_name,
    input: parseJsonObject(row.input),
    updatedAt: row.updated_at,
  }));
});

function parseJsonObject(value: string | null): unknown {
  if (value === null) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
