import type { EnvironmentId, OrchestrationV2ThreadShell, ThreadId } from "@t3tools/contracts";
import { parseThreadLinkHref } from "@t3tools/shared/threadLinks";
import * as Schema from "effect/Schema";

/** New comments on a team's issues, with what routing needs. Checked against Linear's public schema. */
export const INBOX_QUERY = `query LinearInbox(
  $key: String!
  $since: DateTimeOrDuration!
  $first: Int!
  $after: String
) {
  teams(filter: { key: { eq: $key } }, first: 1) {
    nodes { members(first: 250) { nodes { id } } }
  }
  comments(
    first: $first
    after: $after
    orderBy: createdAt
    filter: { createdAt: { gt: $since }, issue: { team: { key: { eq: $key } } } }
  ) {
    nodes {
      id
      body
      createdAt
      user { id name displayName }
      botActor { id }
      externalUser { id }
      issue {
        identifier
        state { type }
        attachments(first: 50) { nodes { url createdAt creator { id } } }
      }
    }
    pageInfo { hasNextPage endCursor }
  }
}`;

export const INBOX_PAGE_SIZE = 100;
/** 1,000 comments; more than that in one poll only follows a long outage. */
export const MAX_INBOX_PAGES = 10;

const Nodes = <S extends Schema.Top>(item: S) => Schema.Struct({ nodes: Schema.Array(item) });

const LinearComment = Schema.Struct({
  id: Schema.String,
  body: Schema.String,
  createdAt: Schema.String,
  user: Schema.NullOr(
    Schema.Struct({ id: Schema.String, name: Schema.String, displayName: Schema.String }),
  ),
  botActor: Schema.NullOr(Schema.Struct({ id: Schema.NullOr(Schema.String) })),
  externalUser: Schema.NullOr(Schema.Struct({ id: Schema.String })),
  issue: Schema.NullOr(
    Schema.Struct({
      identifier: Schema.String,
      state: Schema.Struct({ type: Schema.String }),
      attachments: Nodes(
        Schema.Struct({
          url: Schema.String,
          createdAt: Schema.String,
          creator: Schema.NullOr(Schema.Struct({ id: Schema.String })),
        }),
      ),
    }),
  ),
});
export type LinearComment = typeof LinearComment.Type;

export const InboxData = Schema.Struct({
  teams: Nodes(Schema.Struct({ members: Nodes(Schema.Struct({ id: Schema.String })) })),
  comments: Schema.Struct({
    nodes: Schema.Array(LinearComment),
    pageInfo: Schema.Struct({
      hasNextPage: Schema.Boolean,
      endCursor: Schema.NullOr(Schema.String),
    }),
  }),
});
export type InboxData = typeof InboxData.Type;

export type SkipReason =
  | "not-on-an-issue"
  | "own-comment"
  | "not-a-person"
  | "not-a-team-member"
  | "issue-not-started"
  | "no-thread-link"
  | "thread-missing"
  | "thread-archived"
  | "provider-not-supported"
  | "thread-inactive";

/** A comment that starts with "agent:" was written by a teammate's agent; any other is the person. */
export type CommentKind = "agent" | "person";

export type CommentRoute =
  | {
      readonly _tag: "thread";
      readonly threadId: ThreadId;
      readonly kind: CommentKind;
      readonly sender: string;
    }
  | { readonly _tag: "skip"; readonly reason: SkipReason };

const skip = (reason: SkipReason): CommentRoute => ({ _tag: "skip", reason });

export const commentKind = (body: string): CommentKind =>
  /^agent:/i.test(body.trimStart()) ? "agent" : "person";

/**
 * Which local thread a comment is for. Only a thread link the viewer attached, naming this
 * environment, counts: anyone in the workspace can attach links or comment, so neither may
 * pick the thread. The newest such link wins when an agent moved the work to another thread.
 */
export function routeComment(
  comment: LinearComment,
  context: {
    readonly viewerId: string;
    readonly environmentId: EnvironmentId;
    readonly memberIds: ReadonlySet<string>;
  },
): CommentRoute {
  if (comment.issue === null) return skip("not-on-an-issue");
  if (comment.botActor !== null || comment.externalUser !== null || comment.user === null) {
    return skip("not-a-person");
  }
  if (comment.user.id === context.viewerId) return skip("own-comment");
  if (!context.memberIds.has(comment.user.id)) return skip("not-a-team-member");
  if (comment.issue.state.type !== "started") return skip("issue-not-started");
  const threadId = comment.issue.attachments.nodes
    .filter((attachment) => attachment.creator?.id === context.viewerId)
    .toSorted((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((attachment) => parseThreadLinkHref(attachment.url))
    .find((link) => link?.environmentId === context.environmentId)?.threadId;
  if (threadId === undefined) return skip("no-thread-link");
  return {
    _tag: "thread",
    threadId,
    kind: commentKind(comment.body),
    sender: comment.user.displayName || comment.user.name,
  };
}

/** A thread untouched this long is not woken by a comment; its agent reads the issue when it resumes. */
const ACTIVE_WITHIN_MS = 7 * 24 * 60 * 60_000;

/** Only Claude and Codex agents get the protocol in their preferences, so only they get comments. */
const SUPPORTED_DRIVERS: ReadonlySet<string> = new Set(["claudeAgent", "codex"]);

export function threadSkipReason(
  thread: Pick<OrchestrationV2ThreadShell, "archivedAt" | "updatedAt"> | null,
  driverKind: string | undefined,
  nowMs: number,
): SkipReason | null {
  if (thread === null) return "thread-missing";
  if (thread.archivedAt !== null) return "thread-archived";
  if (driverKind === undefined || !SUPPORTED_DRIVERS.has(driverKind)) {
    return "provider-not-supported";
  }
  if (nowMs - thread.updatedAt.epochMilliseconds > ACTIVE_WITHIN_MS) return "thread-inactive";
  return null;
}
