import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, ThreadId } from "./baseSchemas.ts";
import type { OrchestrationMessageContext } from "./composerContext.ts";
import type { OrchestrationV2ThreadShell } from "./orchestrationV2.ts";

/**
 * Each project has one Inbox: an ordinary thread named "Inbox" that the server makes and that the
 * user talks to about all of the project's threads. It runs on Claude with read tools only. The
 * wire carries nothing new for it: the server knows its thread from its own state file, and a
 * client finds it with `isInboxThreadShell`.
 */

/** The model a new Inbox thread starts on. The user can pick another Claude model. */
export const INBOX_AGENT_DEFAULT_MODEL = "claude-sonnet-5-5";
export const INBOX_AGENT_THREAD_TITLE = "Inbox";

/**
 * Whether a thread looks like a project's Inbox from the fields every client already has: the
 * server made it (no client or agent can create a thread as the system) and it is named "Inbox",
 * a name the server keeps it from losing. A project's Inbox is the oldest such thread.
 */
export function isInboxThreadShell(
  thread:
    | Pick<OrchestrationV2ThreadShell, "title" | "createdBy" | "creationSource" | "lineage">
    | null
    | undefined,
): boolean {
  return (
    thread != null &&
    thread.title === INBOX_AGENT_THREAD_TITLE &&
    thread.createdBy === "system" &&
    thread.creationSource === "server" &&
    thread.lineage.parentThreadId === null
  );
}

/** The kind of the context record that carries a digest on the user's message. */
export const INBOX_AGENT_DIGEST_CONTEXT_KIND = "inbox-digest";
export const INBOX_AGENT_DIGEST_LABEL = "What changed";
export const INBOX_AGENT_DIGEST_MAX_ENTRIES = 40;
export const INBOX_AGENT_DIGEST_TITLE_MAX_LENGTH = 120;
export const INBOX_AGENT_DIGEST_DETAIL_MAX_LENGTH = 300;

export const InboxAgentDigestEntryKind = Schema.Literals([
  "thread-created",
  "run-finished",
  "run-failed",
  "question",
  "pull-request",
]);
export type InboxAgentDigestEntryKind = typeof InboxAgentDigestEntryKind.Type;

export const InboxAgentDigestEntry = Schema.Struct({
  kind: InboxAgentDigestEntryKind,
  threadId: ThreadId,
  title: Schema.String.check(Schema.isMaxLength(INBOX_AGENT_DIGEST_TITLE_MAX_LENGTH)),
  at: IsoDateTime,
  /** The run's error, or the pull request's URL. */
  detail: Schema.optional(
    Schema.String.check(Schema.isMaxLength(INBOX_AGENT_DIGEST_DETAIL_MAX_LENGTH)),
  ),
});
export type InboxAgentDigestEntry = typeof InboxAgentDigestEntry.Type;

/** What changed in a project's threads between the user's previous Inbox message and this one. */
export const InboxAgentDigest = Schema.Struct({
  since: IsoDateTime,
  until: IsoDateTime,
  entries: Schema.Array(InboxAgentDigestEntry).check(
    Schema.isMaxLength(INBOX_AGENT_DIGEST_MAX_ENTRIES),
  ),
  /** Entries left out to keep the digest small, newest kept. */
  omitted: NonNegativeInt,
});
export type InboxAgentDigest = typeof InboxAgentDigest.Type;

const decodeDigest = Schema.decodeUnknownOption(InboxAgentDigest);

/** The digest a user message carries, or null: only the server attaches one. */
export function inboxAgentDigestOf(
  context: OrchestrationMessageContext | undefined,
): InboxAgentDigest | null {
  for (const record of context?.records ?? []) {
    if (record.kind !== INBOX_AGENT_DIGEST_CONTEXT_KIND || !("payload" in record)) continue;
    const decoded = decodeDigest(record.payload);
    return decoded._tag === "Some" ? decoded.value : null;
  }
  return null;
}
