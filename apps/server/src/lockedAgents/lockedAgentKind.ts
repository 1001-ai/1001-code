import type { LockedAgentKind, OrchestrationV2AppThread } from "@t3tools/contracts";

import { isInboxThread } from "../inboxAgent/inboxAgentThreads.ts";

/** A voice agent thread says so in its lineage; a project's Inbox is the one the server recorded. */
export function lockedAgentKindOf(
  thread: Pick<OrchestrationV2AppThread, "id" | "lineage">,
): LockedAgentKind | null {
  if (thread.lineage.voiceAgent === true) return "voice";
  if (isInboxThread(thread.id)) return "inbox";
  return null;
}
