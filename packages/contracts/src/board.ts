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
 * them with its owner's own Linear OAuth sign-in, whose tokens never leave the server.
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
  /** The environment has no Linear OAuth application configured, so nobody can sign in. */
  Schema.Struct({ status: Schema.Literal("unavailable") }),
  Schema.Struct({
    status: Schema.Literal("disconnected"),
    /** Why the last sign-in failed, until the next one starts. */
    signInFailure: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({ status: Schema.Literal("connected"), viewer: BoardViewer }),
]);
export type BoardConnection = typeof BoardConnection.Type;

export const BoardFailureReason = Schema.Literals([
  /** Linear rejected the credential. */
  "unauthorized",
  /** The environment has no Linear OAuth application configured. */
  "sign-in-unavailable",
  "team-not-found",
  "project-not-found",
  "rate-limited",
  "unreachable",
  "invalid-response",
  /** The issue is not on the project's board. */
  "issue-not-found",
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
  linkedAt: IsoDateTime,
  /** The Linear user whose sign-in added the link; null when Linear records none. */
  linkedBy: Schema.NullOr(BoardUser),
});
export type BoardThreadLink = typeof BoardThreadLink.Type;

/** Linear's priority: 0 none, 1 urgent, 2 high, 3 medium, 4 low. */
export const BoardPriority = Schema.Literals([0, 1, 2, 3, 4]);
export type BoardPriority = typeof BoardPriority.Type;

export const BoardIssue = Schema.Struct({
  id: TrimmedNonEmptyString,
  identifier: TrimmedNonEmptyString,
  title: Schema.String,
  url: TrimmedNonEmptyString,
  stateId: TrimmedNonEmptyString,
  assignee: Schema.NullOr(BoardUser),
  labels: Schema.Array(BoardLabel),
  priority: BoardPriority,
  createdAt: IsoDateTime,
  /** When the issue last moved into a started state; null once moved back. */
  startedAt: Schema.NullOr(IsoDateTime),
  updatedAt: IsoDateTime,
  pullRequests: Schema.Array(BoardPullRequest),
  /** Newest link first, one per thread. */
  threads: Schema.Array(BoardThreadLink),
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

export const BoardIssueDetailInput = Schema.Struct({
  projectId: ProjectId,
  issueId: TrimmedNonEmptyString,
});
export type BoardIssueDetailInput = typeof BoardIssueDetailInput.Type;

export const BoardComment = Schema.Struct({
  id: TrimmedNonEmptyString,
  /** Markdown. */
  body: Schema.String,
  author: Schema.String,
  createdAt: IsoDateTime,
  /** Written by a teammate's agent: the body starts with "agent:". */
  agent: Schema.Boolean,
});
export type BoardComment = typeof BoardComment.Type;

/** A top-level comment and its replies. */
export const BoardCommentThread = Schema.Struct({
  ...BoardComment.fields,
  /** Oldest first. */
  replies: Schema.Array(BoardComment),
});
export type BoardCommentThread = typeof BoardCommentThread.Type;

/** What a card leaves out, read from Linear when the issue is opened. */
export const BoardIssueDetail = Schema.Struct({
  description: Schema.NullOr(Schema.String),
  creator: Schema.NullOr(BoardUser),
  /** Oldest first. */
  comments: Schema.Array(BoardCommentThread),
  /**
   * The local thread a comment posted from the board also goes to: the newest link to a thread on
   * this environment that the signed-in person attached, as the comment inbox picks it.
   */
  linkedThreadId: Schema.NullOr(ThreadId),
});
export type BoardIssueDetail = typeof BoardIssueDetail.Type;

export const BoardCommentInput = Schema.Struct({
  projectId: ProjectId,
  issueId: TrimmedNonEmptyString,
  body: TrimmedNonEmptyString,
  /** The top-level comment this replies to. */
  parentId: Schema.optionalKey(TrimmedNonEmptyString),
});
export type BoardCommentInput = typeof BoardCommentInput.Type;

export const BoardCommentResult = Schema.Struct({
  /** The local thread the comment was queued in; null when none is linked or queueing failed. */
  threadId: Schema.NullOr(ThreadId),
});
export type BoardCommentResult = typeof BoardCommentResult.Type;

export const BoardConnectionSubscribeInput = Schema.Struct({});

export const BoardConnectInput = Schema.Struct({
  /** The environment's origin as the signing-in browser reaches it; Linear redirects back there. */
  callbackOrigin: TrimmedNonEmptyString.check(Schema.isMaxLength(500)),
});
export type BoardConnectInput = typeof BoardConnectInput.Type;

/** Where the client sends the browser to sign in to Linear. */
export const BoardSignIn = Schema.Struct({ authorizeUrl: TrimmedNonEmptyString });
export type BoardSignIn = typeof BoardSignIn.Type;

export const BoardDisconnectInput = Schema.Struct({});

/**
 * What an agent's Linear `save_issue` call did to a task: filed it, picked it up (set its
 * assignee) or moved it (set its state). The server reads it from the call's input and Linear's
 * result and sends it as `output.boardTask` on the wire tool item, so the chat shows a card.
 */
export const BoardTaskChange = Schema.Struct({
  kind: Schema.Literals(["created", "picked_up", "status"]),
  /** Linear's issue identifier, such as `COD-106`. */
  identifier: TrimmedNonEmptyString,
  title: Schema.String,
  url: Schema.String,
  status: Schema.String,
  /** One of BOARD_STATE_TYPES when Linear sends it. */
  statusType: Schema.optionalKey(Schema.String),
  assignee: Schema.optionalKey(Schema.String),
  assigneeId: Schema.optionalKey(Schema.String),
  project: Schema.optionalKey(Schema.String),
});
export type BoardTaskChange = typeof BoardTaskChange.Type;
