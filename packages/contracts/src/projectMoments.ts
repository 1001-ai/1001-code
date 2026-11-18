import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  MessageId,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

/**
 * Moments are the points in a project's recent work a person may want to jump to: what agents
 * asked, what they were told, what they finished, and the pull requests they opened. The server
 * derives them from the thread projections; nothing stores them.
 */
export const PROJECT_MOMENTS_WINDOW_DAYS = 7;
export const PROJECT_MOMENTS_LIMIT = 300;
export const PROJECT_MOMENT_SNIPPET_MAX_LENGTH = 200;

export const ProjectMomentKind = Schema.Literals([
  /** An assistant message that asked question cards. */
  "question",
  /** A provider question still waiting for an answer. */
  "input-request",
  /** A thread's first prompt, sent by a person or a scheduled task; later prompts are not moments. */
  "thread-started",
  /** A message another agent sent to this thread's agent. */
  "agent-in",
  /** A message this thread's agent sent to an agent in a linked environment. */
  "agent-out",
  /** A run that finished. */
  "done",
  /** A pull request whose checks are running. */
  "pr-testing",
  "pr-merged",
]);
export type ProjectMomentKind = typeof ProjectMomentKind.Type;

export const ProjectMomentSender = Schema.Struct({
  kind: Schema.Literals(["user", "scheduled-task", "agent", "linked-agent"]),
  /** The sending thread's title, or the linked environment's label; null when unknown. */
  title: Schema.NullOr(Schema.String),
});
export type ProjectMomentSender = typeof ProjectMomentSender.Type;

export const ProjectMomentPullRequest = Schema.Struct({
  number: PositiveInt,
  url: TrimmedNonEmptyString,
  title: Schema.NullOr(Schema.String),
});
export type ProjectMomentPullRequest = typeof ProjectMomentPullRequest.Type;

export const ProjectMoment = Schema.Struct({
  /** Stable across updates: the same moment always has the same id. */
  id: TrimmedNonEmptyString,
  kind: ProjectMomentKind,
  threadId: ThreadId,
  threadTitle: Schema.String,
  at: IsoDateTime,
  /** The message to scroll to in the thread; null when the moment has none. */
  messageId: Schema.NullOr(MessageId),
  snippet: Schema.String.check(Schema.isMaxLength(PROJECT_MOMENT_SNIPPET_MAX_LENGTH)),
  sender: Schema.optional(ProjectMomentSender),
  pullRequest: Schema.optional(ProjectMomentPullRequest),
});
export type ProjectMoment = typeof ProjectMoment.Type;

export const ProjectMomentsSubscribeInput = Schema.Struct({ projectId: ProjectId });
export type ProjectMomentsSubscribeInput = typeof ProjectMomentsSubscribeInput.Type;

export const ProjectMomentsStreamItem = Schema.Union([
  /** The newest moments of the window, oldest first. */
  Schema.Struct({
    kind: Schema.Literal("snapshot"),
    moments: Schema.Array(ProjectMoment),
    /** Older moments in the window were left out to stay within the limit. */
    truncated: Schema.Boolean,
  }),
  Schema.Struct({ kind: Schema.Literal("upsert"), moment: ProjectMoment }),
  Schema.Struct({ kind: Schema.Literal("remove"), id: TrimmedNonEmptyString }),
  Schema.Struct({ kind: Schema.Literal("remove-thread"), threadId: ThreadId }),
]);
export type ProjectMomentsStreamItem = typeof ProjectMomentsStreamItem.Type;
