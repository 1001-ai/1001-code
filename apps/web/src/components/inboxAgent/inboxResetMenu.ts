import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import type { useRouter } from "@tanstack/react-router";

/** Resets a project's Inbox from the thread action menu without loading the RPC runtime at import time. */
export async function resetInboxFromMenu(input: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly projectDisplayName?: string | null | undefined;
  readonly previousThreadId?: ThreadId | null | undefined;
  readonly router: ReturnType<typeof useRouter>;
}): Promise<boolean> {
  const { resetInboxProject } = await import("../../state/inboxAgent");
  return resetInboxProject(input);
}
