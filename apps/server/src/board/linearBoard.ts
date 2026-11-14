import {
  BOARD_STATE_TYPES,
  BoardError,
  EnvironmentId,
  ThreadId,
  type BoardColumn,
  type BoardData,
  type BoardIssue,
  type BoardPullRequest,
  type BoardThreadLink,
  type BoardWorkflowState,
} from "@t3tools/contracts";
import { parseThreadLinkHref } from "@t3tools/shared/threadLinks";
import * as Schema from "effect/Schema";

/** Linear's GraphQL API, read with a personal API key. Queries checked against Linear's public schema. */
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

export const ISSUES_QUERY = `query BoardIssues($filter: IssueFilter!, $first: Int!, $after: String) {
  issues(filter: $filter, first: $first, after: $after) {
    nodes {
      id
      identifier
      title
      url
      updatedAt
      sortOrder
      state { id }
      assignee { id name displayName avatarUrl isMe }
      labels(first: 20) { nodes { id name color } }
      attachments(first: 20) { nodes { url sourceType metadata } }
    }
    pageInfo { hasNextPage endCursor }
  }
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

const LinearIssue = Schema.Struct({
  id: Schema.String,
  identifier: Schema.String,
  title: Schema.String,
  url: Schema.String,
  updatedAt: Schema.String,
  sortOrder: Schema.Number,
  state: Schema.Struct({ id: Schema.String }),
  assignee: Schema.NullOr(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      displayName: Schema.String,
      avatarUrl: Schema.NullOr(Schema.String),
      isMe: Schema.Boolean,
    }),
  ),
  labels: Nodes(Schema.Struct({ id: Schema.String, name: Schema.String, color: Schema.String })),
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
    return new BoardError({ reason: "unauthorized", detail: "Linear rejected the API key." });
  }
  if (input.status >= 500) {
    return new BoardError({
      reason: "unreachable",
      detail: `Linear is unavailable (HTTP ${input.status}).`,
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

/** A thread link names its environment; one without it cannot be opened from a board. */
function boardThreadLink(url: string): BoardThreadLink | null {
  const link = parseThreadLinkHref(url);
  if (link === null || link.environmentId === null) return null;
  const environmentId = decodeEnvironmentId(link.environmentId);
  const threadId = decodeThreadId(link.threadId);
  return environmentId._tag === "Some" && threadId._tag === "Some"
    ? { environmentId: environmentId.value, threadId: threadId.value }
    : null;
}

function boardIssue(issue: LinearIssue): BoardIssue {
  const attachments = issue.attachments.nodes;
  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    url: issue.url,
    stateId: issue.state.id,
    assignee:
      issue.assignee === null
        ? null
        : {
            id: issue.assignee.id,
            name: issue.assignee.displayName || issue.assignee.name,
            avatarUrl: issue.assignee.avatarUrl,
            isMe: issue.assignee.isMe,
          },
    labels: issue.labels.nodes.map(({ id, name, color }) => ({ id, name, color })),
    updatedAt: issue.updatedAt,
    pullRequests: attachments.flatMap((attachment) => boardPullRequest(attachment) ?? []),
    thread: attachments.reduce<BoardThreadLink | null>(
      (found, attachment) => found ?? boardThreadLink(attachment.url),
      null,
    ),
  };
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
