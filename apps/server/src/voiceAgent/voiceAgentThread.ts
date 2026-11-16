import type { OrchestrationV2AppThread, ThreadId } from "@t3tools/contracts";

/**
 * The voice agent's thread hangs under the chat it was opened over the way a side chat does, so
 * every list that leaves side chats out leaves it out too, and `voiceAgent` marks it for the
 * tool lock. It carries no context from that chat. `parent` is null when the chat is gone: the
 * thread stays hidden rather than becoming a listed one.
 */
export function voiceAgentThread(
  thread: OrchestrationV2AppThread,
  voiceAgentOf: ThreadId | undefined,
  parent: Pick<OrchestrationV2AppThread, "lineage"> | null,
): OrchestrationV2AppThread {
  if (voiceAgentOf === undefined) return thread;
  return {
    ...thread,
    lineage: {
      parentThreadId: voiceAgentOf,
      relationshipToParent: "fork",
      rootThreadId: parent?.lineage.rootThreadId ?? voiceAgentOf,
      sideChat: true,
      voiceAgent: true,
    },
  };
}

export function isVoiceAgentThread(thread: {
  readonly lineage: OrchestrationV2AppThread["lineage"];
}): boolean {
  return thread.lineage.voiceAgent === true;
}
