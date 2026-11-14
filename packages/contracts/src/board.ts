import * as Schema from "effect/Schema";

import {
  EnvironmentId,
  IsoDateTime,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

/**
 * The board shows a team project's Linear issues. Linear holds the tasks; each environment reads
 * them with its owner's own Linear credential, which never leaves the server.
 */

export const BoardViewer = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: Schema.String,
  email: Schema.String,
  /** The Linear workspace the credential belongs to. */
  workspace: Schema.String,
});
export type BoardViewer = typeof BoardViewer.Type;

export const BoardConnection = Schema.Union([
  Schema.Struct({ status: Schema.Literal("disconnected") }),
  Schema.Struct({ status: Schema.Literal("connected"), viewer: BoardViewer }),
]);
export type BoardConnection = typeof BoardConnection.Type;

export const BoardFailureReason = Schema.Literals([
  /** Linear rejected the credential. */
  "unauthorized",
  "team-not-found",
  "project-not-found",
  "rate-limited",
  "unreachable",
  "invalid-response",
]);
export type BoardFailureReason = typeof BoardFailureReason.Type;

export const BoardFailure = Schema.Struct({
  reason: BoardFailureReason,
  detail: Schema.String,
  retryAfterSeconds: Schema.optionalKey(PositiveInt),
});
export type BoardFailure = typeof BoardFailure.Type;

export class BoardError extends Schema.TaggedError<BoardError>()("BoardError", {
  reason: BoardFailureReason,
  detail: Schema.String,
  retryAfterSeconds: Schema.optionalKey(PositiveInt),
}) {
  override get message(): string {
    return this.detail;
  }
}

/** Linear's workflow state types, in the order Linear's own board shows them. */
export const BOARD_STATE_TYPES = [
  "triage",
  "backlog",
  "unstarted",
  "started",
  "completed",
  "canceled",
] as const;

export const BoardWorkflowState = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: Schema.String,
  /** One of BOARD_STATE_TYPES; kept open because Linear may add types. */
  type: Schema.String,
  color: Schema.String,
});
export type BoardWorkflowState = typeof BoardWorkflowState.Type;

export const BoardUser = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: Schema.String,
  avatarUrl: Schema.NullOr(Schema.String),
  /** The connected Linear user. */
  isMe: Schema.Boolean,
});
export type BoardUser = typeof BoardUser.Type;

export const BoardLabel = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: Schema.String,
  color: Schema.String,
});
export type BoardLabel = typeof BoardLabel.Type;

/** A pull request attached to the issue, as `host`, `owner/repo` and number. */
export const BoardPullRequest = Schema.Struct({
  url: TrimmedNonEmptyString,
  host: TrimmedNonEmptyString,
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
  /** The state Linear's own integration last recorded, when it records one. */
  linearStatus: Schema.NullOr(Schema.String),
});
export type BoardPullRequest = typeof BoardPullRequest.Type;

/** A T3 Code thread linked to the issue by a thread link attachment. */
export const BoardThreadLink = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
});
export type BoardThreadLink = typeof BoardThreadLink.Type;

export const BoardIssue = Schema.Struct({
  id: TrimmedNonEmptyString,
  identifier: TrimmedNonEmptyString,
  title: Schema.String,
  url: TrimmedNonEmptyString,
  stateId: TrimmedNonEmptyString,
  assignee: Schema.NullOr(BoardUser),
  labels: Schema.Array(BoardLabel),
  updatedAt: IsoDateTime,
  pullRequests: Schema.Array(BoardPullRequest),
  thread: Schema.NullOr(BoardThreadLink),
});
export type BoardIssue = typeof BoardIssue.Type;

export const BoardColumn = Schema.Struct({
  state: BoardWorkflowState,
  issues: Schema.Array(BoardIssue),
});
export type BoardColumn = typeof BoardColumn.Type;

export const BoardData = Schema.Struct({
  team: Schema.Struct({ id: TrimmedNonEmptyString, key: Schema.String, name: Schema.String }),
  project: Schema.NullOr(
    Schema.Struct({ id: TrimmedNonEmptyString, name: Schema.String, url: Schema.String }),
  ),
  /** The team's workflow states in board order, each with its issues in Linear's manual order. */
  columns: Schema.Array(BoardColumn),
  /** More issues matched than one read fetches; the board shows the first ones. */
  truncated: Schema.Boolean,
  fetchedAt: IsoDateTime,
});
export type BoardData = typeof BoardData.Type;

export const BoardUnconfiguredReason = Schema.Literals([
  /** The environment has no team catalog. */
  "no-catalog",
  /** No catalog project lists this project's repository. */
  "not-in-catalog",
  /** The catalog project names no Linear team. */
  "no-linear-team",
]);
export type BoardUnconfiguredReason = typeof BoardUnconfiguredReason.Type;

export const BoardSnapshot = Schema.Union([
  Schema.Struct({ status: Schema.Literal("not-connected") }),
  Schema.Struct({
    status: Schema.Literal("unconfigured"),
    reason: BoardUnconfiguredReason,
    /** The catalog file to edit, when the project is in the catalog. */
    catalogFile: Schema.NullOr(Schema.String),
  }),
  Schema.Struct({
    status: Schema.Literal("ready"),
    board: BoardData,
    /** The last read's failure while this board, from an earlier read, is still shown. */
    failure: Schema.NullOr(BoardFailure),
  }),
  Schema.Struct({ status: Schema.Literal("failed"), failure: BoardFailure }),
]);
export type BoardSnapshot = typeof BoardSnapshot.Type;

export const BoardProjectInput = Schema.Struct({ projectId: ProjectId });
export type BoardProjectInput = typeof BoardProjectInput.Type;

export const BoardConnectionSubscribeInput = Schema.Struct({});

export const BoardConnectInput = Schema.Struct({
  apiKey: TrimmedNonEmptyString.check(Schema.isMaxLength(500)),
});
export type BoardConnectInput = typeof BoardConnectInput.Type;

export const BoardDisconnectInput = Schema.Struct({});
