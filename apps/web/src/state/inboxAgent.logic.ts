import {
  isInboxThreadShell,
  type OrchestrationV2ThreadShell,
  type ProjectId,
  ProviderDriverKind,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

/** What a row for a project's Inbox shows as a dot. */
export type InboxAgentStatus = "running" | "waiting" | "idle";

/** Why a project's Inbox cannot open yet: only the server makes one. */
export const INBOX_UNAVAILABLE_REASON =
  "The server makes this project's Inbox once Claude is ready on it.";

export const INBOX_COMPOSER_PLACEHOLDER = "Ask about this project's threads";

export type InboxShell = Pick<
  OrchestrationV2ThreadShell,
  | "id"
  | "projectId"
  | "title"
  | "createdBy"
  | "creationSource"
  | "lineage"
  | "createdAt"
  | "activeRunId"
  | "activityRunStatus"
  | "pendingRuntimeRequest"
  | "openQuestionsAt"
>;

/**
 * The project's Inbox among the client's shells: the oldest thread the server made and named
 * "Inbox", as the server picks it. Nothing on the wire marks it otherwise.
 */
export function findInboxThread<Shell extends InboxShell>(
  threads: ReadonlyArray<Shell>,
  projectId: ProjectId,
): Shell | null {
  let found: Shell | null = null;
  for (const thread of threads) {
    if (thread.projectId !== projectId || !isInboxThreadShell(thread)) continue;
    if (
      found === null ||
      DateTime.toEpochMillis(thread.createdAt) < DateTime.toEpochMillis(found.createdAt)
    ) {
      found = thread;
    }
  }
  return found;
}

export function inboxAgentStatus(shell: InboxShell | null): InboxAgentStatus {
  if (shell === null) return "idle";
  if (
    shell.activityRunStatus === "waiting" ||
    shell.pendingRuntimeRequest != null ||
    shell.openQuestionsAt != null
  ) {
    return "waiting";
  }
  return shell.activeRunId !== null ? "running" : "idle";
}

/** A client thread, whose raw shell is its `source`; a local draft may have none. */
type ClientThread = {
  readonly source?: Parameters<typeof isInboxThreadShell>[0];
} | null;

export function isInboxClientThread(thread: ClientThread | undefined): boolean {
  return isInboxThreadShell(thread?.source);
}

const CLAUDE = ProviderDriverKind.make("claudeAgent");

/** The Inbox runs on Claude only: its model picker offers Claude's models and no other provider. */
export function inboxAgentLockedProvider(
  thread: ClientThread | undefined,
): ProviderDriverKind | null {
  return isInboxClientThread(thread) ? CLAUDE : null;
}

export function inboxComposerPlaceholder(
  thread: ClientThread | undefined,
  fallback: string,
): string {
  return isInboxClientThread(thread) ? INBOX_COMPOSER_PLACEHOLDER : fallback;
}

const withoutInbox = new WeakMap<ReadonlyArray<unknown>, ReadonlyArray<unknown>>();

/**
 * The sidebar's thread list without Inbox threads, which have their own rows. The same input
 * gives the same array, and one without an Inbox comes back as it is, so memoized rows keep.
 */
export function withoutInboxThreads<Thread extends NonNullable<ClientThread>>(
  threads: ReadonlyArray<Thread>,
): ReadonlyArray<Thread> {
  const cached = withoutInbox.get(threads);
  if (cached !== undefined) return cached as ReadonlyArray<Thread>;
  const kept = threads.some(isInboxClientThread)
    ? threads.filter((thread) => !isInboxClientThread(thread))
    : threads;
  withoutInbox.set(threads, kept);
  return kept;
}
