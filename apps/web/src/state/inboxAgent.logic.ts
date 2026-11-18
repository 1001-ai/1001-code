import {
  type OrchestrationV2ThreadShell,
  type ProjectId,
  ProviderDriverKind,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

/** What a row for a project's Inbox shows as a dot. */
export type InboxAgentStatus = "running" | "waiting" | "idle";

type InboxShell = Pick<
  OrchestrationV2ThreadShell,
  | "id"
  | "projectId"
  | "lineage"
  | "createdAt"
  | "activeRunId"
  | "activityRunStatus"
  | "pendingRuntimeRequest"
  | "openQuestionsAt"
>;

/** The project's Inbox thread among the client's shells: the oldest, as the server picks it. */
export function findInboxAgentShell<Shell extends InboxShell>(
  threads: ReadonlyArray<Shell>,
  projectId: ProjectId,
): Shell | null {
  let found: Shell | null = null;
  for (const thread of threads) {
    if (thread.projectId !== projectId || thread.lineage.inboxAgent !== true) continue;
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

const CLAUDE = ProviderDriverKind.make("claudeAgent");

/** The Inbox runs on Claude only: its model picker offers Claude's models and no other provider. */
export function inboxAgentLockedProvider(
  thread: { readonly lineage: { readonly inboxAgent?: boolean | undefined } } | null | undefined,
): ProviderDriverKind | null {
  return thread?.lineage.inboxAgent === true ? CLAUDE : null;
}
