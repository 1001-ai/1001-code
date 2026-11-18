import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  type EnvironmentId,
  isInboxThreadShell,
  type ScopedProjectRef,
  type ThreadId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";

import { useStableCallback } from "../hooks/useStableCallback";
import { buildThreadRouteParams } from "../threadRoutes";
import {
  findInboxThread,
  INBOX_UNAVAILABLE_REASON,
  type InboxAgentStatus,
  inboxAgentStatus,
} from "./inboxAgent.logic";
import { environmentThreadShells } from "./threads";

const NO_ENVIRONMENT = "" as EnvironmentId;

export interface InboxAgentHandle {
  /** The Inbox thread, once this client has its shell. */
  readonly threadId: ThreadId | null;
  readonly status: InboxAgentStatus;
  /** Why it cannot open, while the server has not made it yet. */
  readonly unavailableReason: string | null;
  /** Shows the project's Inbox at its own thread route. */
  readonly open: () => Promise<void>;
}

/** A project's Inbox, for a row or action that shows its status and opens it. */
export function useInboxAgent(project: ScopedProjectRef | null): InboxAgentHandle {
  const environmentId = project?.environmentId ?? NO_ENVIRONMENT;
  const threads = useAtomValue(environmentThreadShells.environmentThreadsAtom(environmentId));
  const shell = project === null ? null : findInboxThread(threads, project.projectId);
  const navigate = useNavigate();

  const open = useStableCallback(async () => {
    if (shell === null) return;
    await navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(environmentId, shell.id)),
    });
  });

  return {
    threadId: shell?.id ?? null,
    status: inboxAgentStatus(shell),
    unavailableReason: project !== null && shell === null ? INBOX_UNAVAILABLE_REASON : null,
    open,
  };
}

/** Whether a thread is a project's Inbox, for views that have only its id. */
export function useIsInboxThread(environmentId: EnvironmentId, threadId: ThreadId): boolean {
  const shell = useAtomValue(environmentThreadShells.environmentThreadIndexAtom(environmentId)).get(
    threadId,
  );
  return isInboxThreadShell(shell);
}
