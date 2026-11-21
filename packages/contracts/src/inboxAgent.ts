import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, ThreadId } from "./baseSchemas.ts";
import type { OrchestrationMessageContext } from "./composerContext.ts";
import { ANTIGRAVITY_DEFAULT_MODEL } from "./model.ts";
import type { OrchestrationV2ThreadShell } from "./orchestrationV2.ts";
import type { ProviderDriverKind } from "./providerInstance.ts";

/**
 * Each project has one Inbox: an ordinary thread named "Inbox" that the server makes and that the
 * user talks to about all of the project's threads. It runs on a supported locked-agent provider
 * (Claude or Antigravity) with only its own tools. The wire carries nothing new for it: the server
 * knows its thread from its own state file, and a client finds it with `isInboxThreadShell`.
 */

/** The model a new Claude Inbox thread starts on, at medium effort. The user can pick another model or provider. */
export const INBOX_AGENT_DEFAULT_MODEL = "claude-opus-5-5";
export const INBOX_AGENT_DEFAULT_EFFORT = "medium";
export const INBOX_AGENT_THREAD_TITLE = "Inbox";
/** The Inbox's tool that passes a teammate's message on, unchanged, to one of its project's threads. */
export const INBOX_FORWARD_TOOL_NAME = "inbox_forward";

/** Default model for a new Inbox thread on a supported locked-agent driver. */
export function inboxAgentDefaultModel(driver: ProviderDriverKind): string {
  return driver === "antigravity" ? ANTIGRAVITY_DEFAULT_MODEL : INBOX_AGENT_DEFAULT_MODEL;
}

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
    thread.lineage.parentThreadId === null &&
    thread.lineage.sideChat !== true
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
  "run-started",
  "run-finished",
  "run-failed",
  "question",
  "pull-request",
  /** A linked pull request was merged; the detail is its URL and title. */
  "pull-request-merged",
  /** An agent of the thread moved a Board task to a completed state. */
  "task-completed",
  /** A teammate's message reached a thread: directly, through the Inbox, or forwarded by it. */
  "message-received",
  /** A teammate's message reached no thread; the detail says why. */
  "message-not-delivered",
  /** The project's `stable` tag moved to a new build; the detail lists its pull requests. */
  "stable-moved",
]);
export type InboxAgentDigestEntryKind = typeof InboxAgentDigestEntryKind.Type;

export const InboxAgentDigestEntry = Schema.Struct({
  kind: InboxAgentDigestEntryKind,
  threadId: ThreadId,
  title: Schema.String.check(Schema.isMaxLength(INBOX_AGENT_DIGEST_TITLE_MAX_LENGTH)),
  at: IsoDateTime,
  /**
   * The run's error or the first line of its last answer, the pull request's URL, the task, or
   * where a teammate's message went and why.
   */
  detail: Schema.optional(
    Schema.String.check(Schema.isMaxLength(INBOX_AGENT_DIGEST_DETAIL_MAX_LENGTH)),
  ),
});
export type InboxAgentDigestEntry = typeof InboxAgentDigestEntry.Type;

/** What changed in a project's threads since the previous message to the Inbox (the user's or the app's). */
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
