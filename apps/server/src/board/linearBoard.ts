import {
  BOARD_STATE_TYPES,
  BoardError,
  EnvironmentId,
  ThreadId,
  type BoardColumn,
  type BoardComment,
  type BoardCommentThread,
  type BoardData,
  type BoardIssue,
  type BoardIssueDetail,
  type BoardPriority,
  type BoardPullRequest,
  type BoardTask,
  type BoardThreadLink,
  type BoardUser,
  type BoardWorkflowState,
} from "@t3tools/contracts";
import { DEFAULT_HOSTED_APP_URL } from "@t3tools/shared/connectAuth";
import {
  THREAD_LINK_PROTOCOL,
  parseThreadLinkHref,
  threadLinkCandidates,
} from "@t3tools/shared/threadLinks";
import * as Schema from "effect/Schema";

import { CLOSED_STATE_TYPES, commentKind } from "./linearInboxRouting.ts";

/** Linear's GraphQL API, read with an OAuth access token. Queries checked against Linear's public schema. */
export const LINEAR_API_URL = "https://api.linear.app/graphql";

export const ISSUE_PAGE_SIZE = 50;
/** 500 issues; one board read stays a handful of requests against the hourly limit. */
export const MAX_ISSUE_PAGES = 10;
/** Completed and canceled issues stay on the board this long, as on Linear's own board. */
const RECENTLY_CLOSED = "-P7D";

export const VIEWER_QUERY = `query BoardViewer {
  viewer { id name email }
  organization { name }
}`;

export const TEAM_QUERY = `query BoardTeam($key: String!, $project: String!, $withProject: Boolean!) {
  teams(filter: { key: { eq: $key } }, first: 1) {
    nodes {
      id
      key
      name
      states(first: 100) { nodes { id name type color position } }
      projects(
        first: 2
        filter: { or: [{ slugId: { eq: $project } }, { name: { eqIgnoreCase: $project } }] }
      ) @include(if: $withProject) {
        nodes { id slugId name url }
      }
    }
  }
}`;

const USER_FIELDS = "id name displayName avatarUrl isMe";

const HOSTED_THREAD_LINK = JSON.stringify(`${DEFAULT_HOSTED_APP_URL}/threads/`);
const THREAD_LINK_FILTER = `{ or: [{ url: { startsWith: "t3-thread://v2/" } }, { url: { startsWith: ${HOSTED_THREAD_LINK} } }] }`;

export const ISSUES_QUERY = `query BoardIssues($filter: IssueFilter!, $first: Int!, $after: String) {
  issues(filter: $filter, first: $first, after: $after) {
    nodes {
      id
      identifier
      title
      url
      priority
      createdAt
      startedAt
      updatedAt
      sortOrder
      state { id }
      assignee { ${USER_FIELDS} }
      labels(first: 10) { nodes { id name color } }
      threadLinks: attachments(first: 10, filter: ${THREAD_LINK_FILTER}) {
        nodes { url createdAt creator { ${USER_FIELDS} } }
      }
      attachments(
        first: 20
        filter: { and: [{ url: { notStartsWith: "t3-thread://" } }, { url: { notStartsWith: ${HOSTED_THREAD_LINK} } }] }
      ) {
        nodes { url sourceType metadata }
      }
    }
    pageInfo { hasNextPage endCursor }
  }
}`;

/** Comments come flat, replies included; the newest ones when there are more. */
const COMMENT_PAGE_SIZE = 100;

export const ISSUE_DETAIL_QUERY = `query BoardIssueDetail($id: String!) {
  issue(id: $id) {
    id
    identifier
    team { id }
    project { id }
    description
    creator { ${USER_FIELDS} }
    threadLinks: attachments(first: 50, filter: ${THREAD_LINK_FILTER}) {
      nodes { url createdAt creator { id } }
    }
    comments(first: ${COMMENT_PAGE_SIZE}, orderBy: createdAt) {
      nodes {
        id
        body
        createdAt
        parent { id }
        user { name displayName }
        botActor { name }
        externalUser { name }
      }
    }
  }
}`;

export const COMMENT_CREATE_MUTATION = `mutation BoardComment($input: CommentCreateInput!) {
  commentCreate(input: $input) { success comment { id } }
}`;

const TASK_FIELDS =
  "id identifier title url state { name type } assignee { name displayName } project { name }";

export const ISSUE_CREATE_MUTATION = `mutation BoardIssueCreate($input: IssueCreateInput!) {
  issueCreate(input: $input) { success issue { ${TASK_FIELDS} } }
}`;

export const ISSUE_UPDATE_MUTATION = `mutation BoardIssueUpdate($id: String!, $input: IssueUpdateInput!) {
  issueUpdate(id: $id, input: $input) { success issue { ${TASK_FIELDS} } }
}`;

/** Linear keeps one attachment per issue and URL: a second create with the same URL updates it. */
export const THREAD_LINK_MUTATION = `mutation BoardThreadLink($input: AttachmentCreateInput!) {
  attachmentCreate(input: $input) { success }
}`;

/** An issue an agent updates: what it returns, and what decides whether it is on the board. */
export const TASK_QUERY = `query BoardTask($id: String!) {
  issue(id: $id) {
    ${TASK_FIELDS}
    team { id }
    project { id name }
    threadLinks: attachments(first: 50, filter: ${THREAD_LINK_FILTER}) {
      nodes { url creator { id } }
    }
  }
}`;

export const TEAM_MEMBERS_QUERY = `query BoardTeamMembers($id: String!) {
  team(id: $id) { members(first: 250) { nodes { id name displayName email } } }
}`;

/** Open issues of the team (and project), plus those closed within RECENTLY_CLOSED. */
export function issuesFilter(teamId: string, projectId: string | null) {
  return {
    team: { id: { eq: teamId } },
    ...(projectId === null ? {} : { project: { id: { eq: projectId } } }),
    or: [
      { completedAt: { null: true }, canceledAt: { null: true } },
      { completedAt: { gt: RECENTLY_CLOSED } },
      { canceledAt: { gt: RECENTLY_CLOSED } },
    ],
  };
}

const Nodes = <S extends Schema.Top>(item: S) => Schema.Struct({ nodes: Schema.Array(item) });

export const ViewerData = Schema.Struct({
  viewer: Schema.Struct({ id: Schema.String, name: Schema.String, email: Schema.String }),
  organization: Schema.Struct({ name: Schema.String }),
});

const LinearState = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  type: Schema.String,
  color: Schema.String,
  position: Schema.Number,
});
export type LinearState = typeof LinearState.Type;

const LinearProject = Schema.Struct({
  id: Schema.String,
  slugId: Schema.String,
  name: Schema.String,
  url: Schema.String,
});
export type LinearProject = typeof LinearProject.Type;

export const TeamData = Schema.Struct({
  teams: Nodes(
    Schema.Struct({
      id: Schema.String,
      key: Schema.String,
      name: Schema.String,
      states: Nodes(LinearState),
      projects: Schema.optionalKey(Nodes(LinearProject)),
    }),
  ),
});
export type TeamData = typeof TeamData.Type;

/** The project the catalog names: by the id at the end of its URL, else by its only name match. */
export function linearProject(
  candidates: ReadonlyArray<LinearProject>,
  wanted: string,
): NonNullable<BoardData["project"]> | "ambiguous" | null {
  const byName = candidates.filter(
    (candidate) => candidate.name.toLowerCase() === wanted.toLowerCase(),
  );
  const found = candidates.find((candidate) => candidate.slugId === wanted) ?? byName[0];
  if (found === undefined) return null;
  if (found.slugId !== wanted && byName.length > 1) return "ambiguous";
  return { id: found.id, name: found.name, url: found.url };
}

const LinearUser = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  displayName: Schema.String,
  avatarUrl: Schema.NullOr(Schema.String),
  isMe: Schema.Boolean,
});
type LinearUser = typeof LinearUser.Type;

const LinearIssue = Schema.Struct({
  id: Schema.String,
  identifier: Schema.String,
  title: Schema.String,
  url: Schema.String,
  priority: Schema.Number,
  createdAt: Schema.String,
  startedAt: Schema.NullOr(Schema.String),
  updatedAt: Schema.String,
  sortOrder: Schema.Number,
  state: Schema.Struct({ id: Schema.String }),
  assignee: Schema.NullOr(LinearUser),
  labels: Nodes(Schema.Struct({ id: Schema.String, name: Schema.String, color: Schema.String })),
  threadLinks: Nodes(
    Schema.Struct({
      url: Schema.String,
      createdAt: Schema.String,
      creator: Schema.NullOr(LinearUser),
    }),
  ),
  attachments: Nodes(
    Schema.Struct({
      url: Schema.String,
      sourceType: Schema.NullOr(Schema.String),
      metadata: Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown)),
    }),
  ),
});
export type LinearIssue = typeof LinearIssue.Type;

export const IssuesData = Schema.Struct({
  issues: Schema.Struct({
    nodes: Schema.Array(LinearIssue),
    pageInfo: Schema.Struct({
      hasNextPage: Schema.Boolean,
      endCursor: Schema.NullOr(Schema.String),
    }),
  }),
});
export type IssuesData = typeof IssuesData.Type;

const LinearIssueComment = Schema.Struct({
  id: Schema.String,
  body: Schema.String,
  createdAt: Schema.String,
  parent: Schema.NullOr(Schema.Struct({ id: Schema.String })),
  user: Schema.NullOr(Schema.Struct({ name: Schema.String, displayName: Schema.String })),
  botActor: Schema.NullOr(Schema.Struct({ name: Schema.NullOr(Schema.String) })),
  externalUser: Schema.NullOr(Schema.Struct({ name: Schema.String })),
});
type LinearIssueComment = typeof LinearIssueComment.Type;

export const IssueDetailData = Schema.Struct({
  issue: Schema.NullOr(
    Schema.Struct({
      id: Schema.String,
      identifier: Schema.String,
      team: Schema.Struct({ id: Schema.String }),
      project: Schema.NullOr(Schema.Struct({ id: Schema.String })),
      description: Schema.NullOr(Schema.String),
      creator: Schema.NullOr(LinearUser),
      threadLinks: Nodes(
        Schema.Struct({
          url: Schema.String,
          createdAt: Schema.String,
          creator: Schema.NullOr(Schema.Struct({ id: Schema.String })),
        }),
      ),
      comments: Nodes(LinearIssueComment),
    }),
  ),
});
export type IssueDetailData = typeof IssueDetailData.Type;
export type LinearIssueDetail = NonNullable<IssueDetailData["issue"]>;

export const CommentCreateData = Schema.Struct({
  commentCreate: Schema.Struct({
    success: Schema.Boolean,
    comment: Schema.Struct({ id: Schema.String }),
  }),
});

const LinearTask = Schema.Struct({
  id: Schema.String,
  identifier: Schema.String,
  title: Schema.String,
  url: Schema.String,
  state: Schema.Struct({ name: Schema.String, type: Schema.String }),
  assignee: Schema.NullOr(Schema.Struct({ name: Schema.String, displayName: Schema.String })),
  project: Schema.NullOr(Schema.Struct({ name: Schema.String })),
});
type LinearTask = typeof LinearTask.Type;

const IssuePayload = Schema.Struct({ success: Schema.Boolean, issue: Schema.NullOr(LinearTask) });
export const IssueCreateData = Schema.Struct({ issueCreate: IssuePayload });
export const IssueUpdateData = Schema.Struct({ issueUpdate: IssuePayload });
export const ThreadLinkData = Schema.Struct({
  attachmentCreate: Schema.Struct({ success: Schema.Boolean }),
});

export const TaskData = Schema.Struct({
  issue: Schema.NullOr(
    Schema.Struct({
      ...LinearTask.fields,
      team: Schema.Struct({ id: Schema.String }),
      project: Schema.NullOr(Schema.Struct({ id: Schema.String, name: Schema.String })),
      threadLinks: Nodes(
        Schema.Struct({
          url: Schema.String,
          creator: Schema.NullOr(Schema.Struct({ id: Schema.String })),
        }),
      ),
    }),
  ),
});

const LinearMember = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  displayName: Schema.String,
  email: Schema.String,
});
type LinearMember = typeof LinearMember.Type;

export const TeamMembersData = Schema.Struct({
  team: Schema.Struct({ members: Nodes(LinearMember) }),
});

const GraphqlErrors = Schema.Struct({
  errors: Schema.Array(
    Schema.Struct({
      message: Schema.optionalKey(Schema.String),
      extensions: Schema.optionalKey(
        Schema.Struct({
          code: Schema.optionalKey(Schema.String),
          type: Schema.optionalKey(Schema.String),
        }),
      ),
    }),
  ),
});
const decodeGraphqlErrors = Schema.decodeUnknownOption(GraphqlErrors);

const MAX_DETAIL_LENGTH = 300;

/** Linear's answer as a board failure, or null when it carries data and no error. */
export function linearFailure(input: {
  readonly status: number;
  readonly body: unknown;
  readonly retryAfter: string | undefined;
}): BoardError | null {
  const decoded = decodeGraphqlErrors(input.body);
  const errors = decoded._tag === "Some" ? decoded.value.errors : [];
  const codes = new Set(errors.map((error) => error.extensions?.code?.toUpperCase()));
  const types = new Set(errors.map((error) => error.extensions?.type?.toLowerCase()));
  if (input.status === 429 || codes.has("RATELIMITED")) {
    const seconds = Number.parseInt(input.retryAfter ?? "", 10);
    return new BoardError({
      reason: "rate-limited",
      detail: "Linear's rate limit was reached. Try again later.",
      ...(Number.isFinite(seconds) && seconds > 0 ? { retryAfterSeconds: seconds } : {}),
    });
  }
  if (
    input.status === 401 ||
    input.status === 403 ||
    codes.has("AUTHENTICATION_ERROR") ||
    types.has("authentication error")
  ) {
    return new BoardError({ reason: "unauthorized", detail: "Linear rejected your sign-in." });
  }
  if (input.status >= 500) {
    return new BoardError({
      reason: "unreachable",
      detail: `Linear is unavailable (HTTP ${input.status}).`,
    });
  }
  // Only the issue detail looks an entity up by id; the board's own queries filter.
  if (errors.length > 0 && errors.every((error) => error.message?.startsWith("Entity not found"))) {
    return new BoardError({
      reason: "issue-not-found",
      detail: "This issue does not exist or is not visible to your Linear account.",
    });
  }
  if (errors.length > 0 || input.status !== 200) {
    const message = errors.find((error) => error.message)?.message ?? `HTTP ${input.status}`;
    return new BoardError({
      reason: "invalid-response",
      detail: `Linear refused the request: ${message}`.slice(0, MAX_DETAIL_LENGTH),
    });
  }
  return null;
}

const stateTypeRank = (type: string) => {
  const rank = BOARD_STATE_TYPES.indexOf(type as (typeof BOARD_STATE_TYPES)[number]);
  return rank === -1 ? BOARD_STATE_TYPES.length : rank;
};

/** States in the order Linear's board shows them: by type, then by the team's own position. */
function boardStates(states: ReadonlyArray<LinearState>): ReadonlyArray<BoardWorkflowState> {
  return [...states]
    .sort((a, b) => stateTypeRank(a.type) - stateTypeRank(b.type) || a.position - b.position)
    .map(({ id, name, type, color }) => ({ id, name, type, color }));
}

const PULL_REQUEST_PATH = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/;

/** A GitHub pull request link from Linear's GitHub integration or pasted by hand. */
function boardPullRequest(attachment: LinearIssue["attachments"]["nodes"][number]) {
  if (!URL.canParse(attachment.url)) return null;
  const url = new URL(attachment.url);
  const fromGithub =
    url.hostname === "github.com" || attachment.sourceType?.toLowerCase().startsWith("github");
  const match = PULL_REQUEST_PATH.exec(url.pathname);
  if (!fromGithub || !match) return null;
  const number = Number(match[3]);
  if (!Number.isSafeInteger(number) || number < 1) return null;
  const status = attachment.metadata?.["status"];
  const pullRequest: BoardPullRequest = {
    url: attachment.url,
    host: url.host,
    repository: `${match[1]}/${match[2]}`,
    number,
    linearStatus: typeof status === "string" ? status : null,
  };
  return pullRequest;
}

const decodeEnvironmentId = Schema.decodeUnknownOption(EnvironmentId);
const decodeThreadId = Schema.decodeUnknownOption(ThreadId);

const boardUser = (user: LinearUser | null): BoardUser | null =>
  user === null
    ? null
    : {
        id: user.id,
        name: user.name || user.displayName,
        avatarUrl: user.avatarUrl,
        isMe: user.isMe,
      };

/** A thread link names its environment; one without it cannot be opened from a board. */
function boardThreadLink(
  attachment: LinearIssue["threadLinks"]["nodes"][number],
): BoardThreadLink | null {
  const link = parseThreadLinkHref(attachment.url);
  if (link === null || link.environmentId === null) return null;
  const environmentId = decodeEnvironmentId(link.environmentId);
  const threadId = decodeThreadId(link.threadId);
  return environmentId._tag === "Some" && threadId._tag === "Some"
    ? {
        environmentId: environmentId.value,
        threadId: threadId.value,
        linkedAt: attachment.createdAt,
        linkedBy: boardUser(attachment.creator),
      }
    : null;
}

/** Newest first; a thread linked in several forms keeps its newest link. */
function boardThreadLinks(issue: LinearIssue): ReadonlyArray<BoardThreadLink> {
  const links = issue.threadLinks.nodes
    .flatMap((attachment) => boardThreadLink(attachment) ?? [])
    .sort((a, b) => Date.parse(b.linkedAt) - Date.parse(a.linkedAt));
  const seen = new Set<string>();
  return links.filter((link) => {
    const key = JSON.stringify([link.environmentId, link.threadId]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const boardPriority = (priority: number): BoardPriority =>
  priority === 1 || priority === 2 || priority === 3 || priority === 4 ? priority : 0;

function boardIssue(issue: LinearIssue): BoardIssue {
  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    url: issue.url,
    stateId: issue.state.id,
    assignee: boardUser(issue.assignee),
    labels: issue.labels.nodes.map(({ id, name, color }) => ({ id, name, color })),
    priority: boardPriority(issue.priority),
    createdAt: issue.createdAt,
    startedAt: issue.startedAt,
    updatedAt: issue.updatedAt,
    pullRequests: issue.attachments.nodes.flatMap(
      (attachment) => boardPullRequest(attachment) ?? [],
    ),
    threads: boardThreadLinks(issue),
  };
}

export const commentAuthor = (comment: LinearIssueComment): string =>
  (comment.user === null
    ? (comment.botActor?.name ?? comment.externalUser?.name)
    : comment.user.name || comment.user.displayName) || "Someone";

const boardComment = (comment: LinearIssueComment): BoardComment => ({
  id: comment.id,
  body: comment.body,
  author: commentAuthor(comment),
  createdAt: comment.createdAt,
  agent: commentKind(comment.body) === "agent",
});

/** Top-level comments with their replies, oldest first; a reply whose comment was not read stands alone. */
function boardCommentThreads(
  comments: ReadonlyArray<LinearIssueComment>,
): ReadonlyArray<BoardCommentThread> {
  const sorted = comments.toSorted((a, b) => a.createdAt.localeCompare(b.createdAt));
  const parents = new Map(sorted.map((comment) => [comment.id, comment.parent?.id ?? null]));
  // Linear's own UI nests one level, but its API lets a reply answer a reply: file it under the root.
  const rootOf = (id: string): string => {
    const seen = new Set<string>();
    let current = id;
    for (let parent = parents.get(current); parent != null && parents.has(parent);) {
      if (seen.has(parent)) break;
      seen.add(parent);
      current = parent;
      parent = parents.get(current);
    }
    return current;
  };
  const replies = new Map<string, Array<BoardComment>>();
  for (const comment of sorted) {
    const root = rootOf(comment.id);
    if (root === comment.id) continue;
    const list = replies.get(root) ?? [];
    list.push(boardComment(comment));
    replies.set(root, list);
  }
  return sorted
    .filter((comment) => rootOf(comment.id) === comment.id)
    .map((comment) => ({ ...boardComment(comment), replies: replies.get(comment.id) ?? [] }));
}

export function boardIssueDetail(
  issue: LinearIssueDetail,
  linkedThreadId: ThreadId | null,
): BoardIssueDetail {
  return {
    description: issue.description,
    creator: boardUser(issue.creator),
    comments: boardCommentThreads(issue.comments.nodes),
    linkedThreadId,
  };
}

/**
 * What the linked thread's agent gets when the user comments from the board. It is the user's own
 * message, so it needs no framing, only where it was posted and whom it answers.
 */
export function postedCommentText(input: {
  readonly issue: string;
  readonly body: string;
  /** The author of the comment this replies to; null for a top-level comment. */
  readonly replyTo: string | null;
}): string {
  const where =
    input.replyTo === null
      ? `I commented on ${input.issue} in Linear:`
      : `I replied to ${input.replyTo}'s comment on ${input.issue} in Linear:`;
  return `${where}\n\n${input.body.trim()}`;
}

/** One column per state, in board order, each with its issues in Linear's manual order. */
export function boardColumns(
  states: ReadonlyArray<LinearState>,
  issues: ReadonlyArray<LinearIssue>,
): ReadonlyArray<BoardColumn> {
  const byState = new Map<string, LinearIssue[]>();
  for (const issue of issues) {
    const list = byState.get(issue.state.id);
    if (list) list.push(issue);
    else byState.set(issue.state.id, [issue]);
  }
  return boardStates(states).map((state) => ({
    state,
    issues: [...(byState.get(state.id) ?? [])]
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map(boardIssue),
  }));
}

/** The link an agent attaches to a task so the board, and teammates' agents, find its thread. */
export const threadLinkUrl = (environmentId: EnvironmentId, threadId: ThreadId) =>
  `${THREAD_LINK_PROTOCOL}://v2/${environmentId}/${threadId}`;

/**
 * Whether the viewer already linked the task to this thread here. Only the viewer's links route
 * comments, so a link someone else attached does not count.
 */
export function hasThreadLink(
  links: ReadonlyArray<{ readonly url: string; readonly creator: { readonly id: string } | null }>,
  viewerId: string,
  environmentId: EnvironmentId,
  threadId: ThreadId,
): boolean {
  return links.some((link) => {
    if (link.creator?.id !== viewerId) return false;
    const parsed = parseThreadLinkHref(link.url);
    return (
      parsed?.environmentId === environmentId &&
      threadLinkCandidates(parsed, environmentId).some((ref) => ref.threadId === threadId)
    );
  });
}

/** The team's workflow state an agent names, ignoring case and surrounding space. */
export function workflowStateNamed(
  states: ReadonlyArray<LinearState>,
  name: string,
): LinearState | null {
  const wanted = name.trim().toLowerCase();
  return states.find((state) => state.name.trim().toLowerCase() === wanted) ?? null;
}

/** The team member an agent names by name, display name or email, ignoring case. */
export function teamMemberNamed(
  members: ReadonlyArray<LinearMember>,
  name: string,
): LinearMember | "ambiguous" | null {
  const wanted = name.trim().toLowerCase();
  const byEmail = members.find((member) => member.email.toLowerCase() === wanted);
  if (byEmail !== undefined) return byEmail;
  const matches = members.filter(
    (member) => member.name.toLowerCase() === wanted || member.displayName.toLowerCase() === wanted,
  );
  return matches.length > 1 ? "ambiguous" : (matches[0] ?? null);
}

export const boardTask = (task: LinearTask): BoardTask => ({
  identifier: task.identifier,
  title: task.title,
  url: task.url,
  status: { name: task.state.name, type: task.state.type },
  assignee: task.assignee === null ? null : task.assignee.displayName || task.assignee.name,
  project: task.project?.name ?? null,
});

/** The board's open tasks, column by column, as an agent lists them. */
export function openBoardTasks(board: BoardData): ReadonlyArray<BoardTask> {
  return board.columns
    .filter((column) => !CLOSED_STATE_TYPES.has(column.state.type))
    .flatMap((column) =>
      column.issues.map((issue) => ({
        identifier: issue.identifier,
        title: issue.title,
        url: issue.url,
        status: { name: column.state.name, type: column.state.type },
        assignee: issue.assignee?.name ?? null,
        project: board.project?.name ?? null,
      })),
    );
}
