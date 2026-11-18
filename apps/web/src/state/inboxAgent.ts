import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  createEnvironmentRpcCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ScopedProjectRef, ThreadId } from "@t3tools/contracts";
import { WS_METHODS } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";

import { toastManager } from "../components/ui/toast";
import { connectionAtomRuntime } from "../connection/runtime";
import { useStableCallback } from "../hooks/useStableCallback";
import { buildThreadRouteParams } from "../threadRoutes";
import { findInboxAgentShell, type InboxAgentStatus, inboxAgentStatus } from "./inboxAgent.logic";
import { environmentThreadShells } from "./threads";
import { useAtomCommand } from "./use-atom-command";

/** Finds the project's Inbox thread, or makes it on the server's first open. */
const inboxAgentOpen = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:inbox-agent:open",
  tag: WS_METHODS.inboxAgentOpen,
});

const NO_ENVIRONMENT = "" as EnvironmentId;

export interface InboxAgentHandle {
  /** The Inbox thread, once this client has its shell. */
  readonly threadId: ThreadId | null;
  readonly status: InboxAgentStatus;
  /** Making the Inbox is an operator's action; one that exists opens for anyone. */
  readonly canOpen: boolean;
  /** Shows the project's Inbox at its own thread route, asking the server only the first time. */
  readonly open: () => Promise<void>;
}

function reportUnavailable(message: string) {
  toastManager.add({ type: "error", title: "Inbox unavailable", description: message });
}

/** A project's Inbox, for a row or action that shows its status and opens it. */
export function useInboxAgent(project: ScopedProjectRef | null): InboxAgentHandle {
  const environmentId = project?.environmentId ?? NO_ENVIRONMENT;
  const threads = useAtomValue(environmentThreadShells.environmentThreadsAtom(environmentId));
  const shell = project === null ? null : findInboxAgentShell(threads, project.projectId);
  const mayCreate = useAtomValue(inboxAgentOpen.permissionAtom(environmentId));
  const ask = useAtomCommand(inboxAgentOpen, { reportFailure: false });
  const navigate = useNavigate();

  const open = useStableCallback(async () => {
    if (project === null) return;
    let threadId = shell?.id ?? null;
    if (threadId === null) {
      const result = await ask({ environmentId, input: { projectId: project.projectId } });
      if (result._tag !== "Success") {
        const failure = squashAtomCommandFailure(result);
        reportUnavailable(
          failure instanceof Error ? failure.message : "The server did not open the Inbox.",
        );
        return;
      }
      if (result.value.status === "unavailable") {
        reportUnavailable(result.value.message);
        return;
      }
      threadId = result.value.threadId;
    }
    await navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(environmentId, threadId)),
    });
  });

  return {
    threadId: shell?.id ?? null,
    status: inboxAgentStatus(shell),
    canOpen: project !== null && (shell !== null || mayCreate),
    open,
  };
}
