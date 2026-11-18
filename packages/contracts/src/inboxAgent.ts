import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, ProjectId, ThreadId } from "./baseSchemas.ts";
import type { OrchestrationMessageContext } from "./composerContext.ts";

/**
 * Each project has one Inbox agent: a hidden thread one level above the project's threads that
 * the user talks to about all of them. It runs on Claude with read tools only.
 */

/** The model a new Inbox thread starts on. The user can pick another Claude model. */
export const INBOX_AGENT_DEFAULT_MODEL = "claude-sonnet-5-5";
export const INBOX_AGENT_THREAD_TITLE = "Inbox";

export const InboxAgentOpenInput = Schema.Struct({ projectId: ProjectId });
export type InboxAgentOpenInput = typeof InboxAgentOpenInput.Type;

export const InboxAgentOpenResult = Schema.Union([
  Schema.Struct({ status: Schema.Literal("ready"), threadId: ThreadId }),
  /** No Inbox can run here, and the one line that says why. */
  Schema.Struct({ status: Schema.Literal("unavailable"), message: Schema.String }),
]);
export type InboxAgentOpenResult = typeof InboxAgentOpenResult.Type;

export const InboxAgentErrorReason = Schema.Literals(["not-created"]);
export type InboxAgentErrorReason = typeof InboxAgentErrorReason.Type;

const ERROR_MESSAGES: Record<InboxAgentErrorReason, string> = {
  "not-created": "The server could not make this project's Inbox. Try again.",
};

export class InboxAgentError extends Schema.TaggedError<InboxAgentError>()("InboxAgentError", {
  reason: InboxAgentErrorReason,
}) {
  override get message(): string {
    return ERROR_MESSAGES[this.reason];
  }
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
