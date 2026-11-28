import type { ProjectId, ThreadId } from "@t3tools/contracts";

/**
 * Each project's Inbox thread, as the server's state file records it. Process-wide, because the
 * orchestrator and the Claude adapter ask about it in upstream code that cannot take a new
 * service; only `InboxAgent` writes it.
 */
const byProject = new Map<ProjectId, ThreadId>();
const threadIds = new Set<ThreadId>();
/** Replaced Inbox thread ids kept so an in-flight relayed run from a reset Inbox can finish. */
const retiredThreadIds = new Set<ThreadId>();
const MAX_RETIRED_INBOX_THREADS = 256;

export function isInboxThread(threadId: ThreadId): boolean {
  return threadIds.has(threadId);
}

/** Whether `threadId` is a project's current Inbox or a previously replaced one. */
export function isKnownInboxThread(threadId: ThreadId): boolean {
  return threadIds.has(threadId) || retiredThreadIds.has(threadId);
}

export function inboxThreadOf(projectId: ProjectId): ThreadId | undefined {
  return byProject.get(projectId);
}

export function recordInboxThread(projectId: ProjectId, threadId: ThreadId): void {
  const previous = byProject.get(projectId);
  if (previous !== undefined && previous !== threadId) {
    threadIds.delete(previous);
    retiredThreadIds.add(previous);
    if (retiredThreadIds.size > MAX_RETIRED_INBOX_THREADS) {
      retiredThreadIds.delete(retiredThreadIds.values().next().value!);
    }
  }
  retiredThreadIds.delete(threadId);
  byProject.set(projectId, threadId);
  threadIds.add(threadId);
}

export function replaceInboxThreads(
  entries: ReadonlyMap<ProjectId, ThreadId>,
  retired: ReadonlyArray<ThreadId> = [],
): void {
  byProject.clear();
  threadIds.clear();
  retiredThreadIds.clear();
  for (const [projectId, threadId] of entries) recordInboxThread(projectId, threadId);
  for (const threadId of retired.slice(-MAX_RETIRED_INBOX_THREADS)) {
    if (!threadIds.has(threadId)) retiredThreadIds.add(threadId);
  }
}

export function inboxThreads(): ReadonlyMap<ProjectId, ThreadId> {
  return new Map(byProject);
}

export function retiredInboxThreads(): ReadonlyArray<ThreadId> {
  return Array.from(retiredThreadIds);
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
