import type { OrchestrationV2AppThread } from "@t3tools/contracts";

/**
 * A project's Inbox thread is a side chat with no parent: every server list, search and
 * notification that leaves side chats out leaves it out too, and with no parent it shows under
 * no chat. `inboxAgent` marks it for the tool lock, the gate, the guard and the digest.
 */
export function inboxAgentThread(
  thread: OrchestrationV2AppThread,
  inboxAgent: boolean | undefined,
): OrchestrationV2AppThread {
  if (inboxAgent !== true) return thread;
  return {
    ...thread,
    lineage: {
      parentThreadId: null,
      relationshipToParent: null,
      rootThreadId: thread.id,
      sideChat: true,
      inboxAgent: true,
    },
  };
}

export function isInboxAgentThread(thread: {
  readonly lineage: OrchestrationV2AppThread["lineage"];
}): boolean {
  return thread.lineage.inboxAgent === true;
}
