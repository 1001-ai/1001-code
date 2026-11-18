import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  createEnvironmentRpcCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { WS_METHODS } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import { useStableCallback } from "../hooks/useStableCallback";
import { buildThreadRouteParams } from "../threadRoutes";
import { findInboxAgentShell, type InboxAgentStatus, inboxAgentStatus } from "./inboxAgent.logic";
import { environmentThreadShells } from "./threads";
import { useAtomCommand } from "./use-atom-command";

/** Finds the project's Inbox thread, or makes it on the server's first open. */
export const inboxAgentOpen = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:inbox-agent:open",
  tag: WS_METHODS.inboxAgentOpen,
});

export interface InboxAgentHandle {
  /** The Inbox thread, once this client has its shell. */
  readonly threadId: ThreadId | null;
  readonly status: InboxAgentStatus;
  /** Whether this connection may open it; making it is an operator's action. */
  readonly canOpen: boolean;
  /** Why the last open found no Inbox, in one line. */
  readonly unavailable: string | null;
  /** Shows the project's Inbox at its own thread route, asking the server only the first time. */
  readonly open: () => Promise<void>;
}

/** A project's Inbox, for a row that shows its status and opens it. */
export function useInboxAgent(
  environmentId: EnvironmentId,
  projectId: ProjectId,
): InboxAgentHandle {
  const threads = useAtomValue(environmentThreadShells.environmentThreadsAtom(environmentId));
  const shell = findInboxAgentShell(threads, projectId);
  const canOpen = useAtomValue(inboxAgentOpen.permissionAtom(environmentId));
  const ask = useAtomCommand(inboxAgentOpen, { reportFailure: false });
  const navigate = useNavigate();
  const [unavailable, setUnavailable] = useState<string | null>(null);

  const open = useStableCallback(async () => {
    let threadId = shell?.id ?? null;
    if (threadId === null) {
      const result = await ask({ environmentId, input: { projectId } });
      if (result._tag !== "Success") {
        const failure = squashAtomCommandFailure(result);
        setUnavailable(
          failure instanceof Error ? failure.message : "The server did not open the Inbox.",
        );
        return;
      }
      if (result.value.status === "unavailable") {
        setUnavailable(result.value.message);
        return;
      }
      threadId = result.value.threadId;
    }
    setUnavailable(null);
    await navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(environmentId, threadId)),
    });
  });

  return {
    threadId: shell?.id ?? null,
    status: inboxAgentStatus(shell),
    canOpen,
    unavailable,
    open,
  };
}
