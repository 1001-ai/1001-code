import { ProjectId, ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

/**
 * What happened to each teammate's message: delivered to a thread (directly, through the Inbox or
 * forwarded by it) or not, and why. `LinearInbox` keeps it in its state file and publishes it
 * here, process-wide, because the Inbox digest is built in upstream intake code that cannot take
 * a new service. Only `LinearInbox` writes it.
 */
export const LinearInboxLogEntry = Schema.Struct({
  commentId: Schema.String,
  /** The exchange's first comment: a reply names it as its parent. */
  rootId: Schema.String,
  /** Linear's id of the issue, for posting a reply. */
  issueId: Schema.String,
  /** Such as ENG-12. */
  issue: Schema.String,
  sender: Schema.String,
  kind: Schema.Literals(["agent", "person"]),
  /** When it was delivered or skipped. */
  at: Schema.String,
  outcome: Schema.Literals(["delivered", "not-delivered"]),
  /** How a delivered message found its thread. */
  via: Schema.optional(
    Schema.Literals(["reply-address", "body-link", "issue-link", "inbox", "forward"]),
  ),
  /** Why it was not delivered: a `SkipReason`. */
  reason: Schema.optional(Schema.String),
  /** The thread it went to, or would have gone to. */
  threadId: Schema.optional(ThreadId),
  /** The local projects it belongs to; its digest shows in their Inboxes. */
  projectIds: Schema.Array(ProjectId),
});
export type LinearInboxLogEntry = typeof LinearInboxLogEntry.Type;

const KEEP_MS = 7 * 24 * 60 * 60_000;
/** Per outcome, so a busy team's undelivered comments never push out what threads may reply to. */
const KEEP_PER_OUTCOME = 200;

/** The entries of the last week, the newest 200 of each outcome, oldest first. */
export function prunedLog(
  entries: ReadonlyArray<LinearInboxLogEntry>,
  nowMs: number,
): ReadonlyArray<LinearInboxLogEntry> {
  const recent = entries.filter((entry) => nowMs - Date.parse(entry.at) < KEEP_MS);
  const delivered = recent.filter((entry) => entry.outcome === "delivered");
  const skipped = recent.filter((entry) => entry.outcome === "not-delivered");
  const kept = new Set([
    ...delivered.slice(-KEEP_PER_OUTCOME),
    ...skipped.slice(-KEEP_PER_OUTCOME),
  ]);
  return recent.filter((entry) => kept.has(entry));
}

/** The newest delivery of a comment into a thread, which that thread may answer. */
export function deliveredTo(
  entries: ReadonlyArray<LinearInboxLogEntry>,
  threadId: ThreadId,
  commentId: string,
): LinearInboxLogEntry | undefined {
  return entries.findLast(
    (entry) =>
      entry.outcome === "delivered" && entry.threadId === threadId && entry.commentId === commentId,
  );
}

let published: ReadonlyArray<LinearInboxLogEntry> = [];

export function publishLinearInboxLog(entries: ReadonlyArray<LinearInboxLogEntry>): void {
  published = entries;
}

export function linearInboxLog(): ReadonlyArray<LinearInboxLogEntry> {
  return published;
}
