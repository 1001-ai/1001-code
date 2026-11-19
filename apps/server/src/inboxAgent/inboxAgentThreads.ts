import type { ProjectId, ThreadId } from "@t3tools/contracts";

/**
 * Each project's Inbox thread, as the server's state file records it. Process-wide, because the
 * orchestrator and the Claude adapter ask about it in upstream code that cannot take a new
 * service; only `InboxAgent` writes it.
 */
const byProject = new Map<ProjectId, ThreadId>();
const threadIds = new Set<ThreadId>();

export function isInboxThread(threadId: ThreadId): boolean {
  return threadIds.has(threadId);
}

export function inboxThreadOf(projectId: ProjectId): ThreadId | undefined {
  return byProject.get(projectId);
}

export function recordInboxThread(projectId: ProjectId, threadId: ThreadId): void {
  const previous = byProject.get(projectId);
  if (previous !== undefined) threadIds.delete(previous);
  byProject.set(projectId, threadId);
  threadIds.add(threadId);
}

export function replaceInboxThreads(entries: ReadonlyMap<ProjectId, ThreadId>): void {
  byProject.clear();
  threadIds.clear();
  for (const [projectId, threadId] of entries) recordInboxThread(projectId, threadId);
}

export function inboxThreads(): ReadonlyMap<ProjectId, ThreadId> {
  return new Map(byProject);
}

/**
 * The thread whose model and modes a `t3_thread_launch` inherits: none for an Inbox, so the new
 * thread starts from the project's defaults, as the composer's New thread does.
 */
export function launchInheritsFrom<Caller extends { readonly id: ThreadId }>(
  caller: Caller | undefined,
): Caller | undefined {
  return caller === undefined || isInboxThread(caller.id) ? undefined : caller;
}
