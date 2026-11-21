import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  createEnvironmentRpcCommand,
  isAtomCommandInterrupted,
  runAtomCommand,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  type EnvironmentId,
  inboxAgentResetFailureMessage,
  isInboxThreadShell,
  type ProjectId,
  type ScopedProjectRef,
  type ScopedThreadRef,
  type ThreadId,
  WS_METHODS,
} from "@t3tools/contracts";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { Atom } from "effect/reactivity";

import { useComposerDraftStore } from "../composerDraftStore";
import { connectionAtomRuntime } from "../connection/runtime";
import { useDiffPanelStore } from "../diffPanelStore";
import { useStableCallback } from "../hooks/useStableCallback";
import { releaseComposerDraftUploads } from "../lib/composerDraftUploads";
import { readLocalApi } from "../localApi";
import { usePreviewMiniPlayerStore } from "../previewMiniPlayerStore";
import { clearThreadPreviewState } from "../previewStateStore";
import { useRightPanelStore } from "../rightPanelStore";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { useTerminalUiStateStore } from "../terminalUiStateStore";
import { buildThreadRouteParams, isThreadRoutePathname } from "../threadRoutes";
import { inboxResetConfirmMessage } from "../components/inboxAgent/inboxResetMenu.logic";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import {
  findInboxThread,
  INBOX_UNAVAILABLE_REASON,
  type InboxAgentStatus,
  inboxAgentStatus,
} from "./inboxAgent.logic";
import { environmentThreadShells } from "./threads";

const NO_ENVIRONMENT = "" as EnvironmentId;

const inboxAgentReset = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:inbox-agent:reset",
  tag: WS_METHODS.inboxAgentReset,
});

const resettingProjectsAtom = Atom.make<ReadonlySet<string>>(new Set<string>()).pipe(
  Atom.withLabel("web-inbox-agent:resetting"),
);

function resetProjectKey(environmentId: EnvironmentId, projectId: ProjectId): string {
  return `${environmentId}:${projectId}`;
}

function clearResetInboxThreadState(ref: ScopedThreadRef): void {
  releaseComposerDraftUploads(ref);
  useComposerDraftStore.getState().clearDraftThread(ref);
  useTerminalUiStateStore.getState().clearTerminalUiState(ref);
  clearThreadPreviewState(ref);
  useRightPanelStore.getState().removeThread(ref);
  useDiffPanelStore.getState().removeThread(ref);
  usePreviewMiniPlayerStore.getState().removeThread(ref);
}

/**
 * Confirms, deletes the project's current Inbox thread, and replaces it with a new one.
 * If the user is currently viewing the old Inbox thread, navigates seamlessly to the new one.
 */
export async function resetInboxProject(input: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly projectDisplayName?: string | null | undefined;
  readonly previousThreadId?: ThreadId | null | undefined;
  readonly router: ReturnType<typeof useRouter>;
}): Promise<boolean> {
  const { environmentId, projectId, router } = input;
  const key = resetProjectKey(environmentId, projectId);
  if (appAtomRegistry.get(resettingProjectsAtom).has(key)) return false;

  if (!appAtomRegistry.get(inboxAgentReset.permissionAtom(environmentId))) {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Cannot reset Inbox",
        description: "This connection is not allowed to reset the Inbox on this server.",
      }),
    );
    return false;
  }

  const api = readLocalApi();
  if (api) {
    const confirmed = await settlePromise(() =>
      api.dialogs.confirm(inboxResetConfirmMessage(input.projectDisplayName), {
        variant: "destructive",
      }),
    );
    if (confirmed._tag === "Failure" || !confirmed.value) return false;
  }

  // Re-check after confirmation in case another click started resetting while the dialog was open.
  const currentResetting = appAtomRegistry.get(resettingProjectsAtom);
  if (currentResetting.has(key)) return false;
  const nextResetting = new Set(currentResetting);
  nextResetting.add(key);
  appAtomRegistry.set(resettingProjectsAtom, nextResetting);

  const initialPathname = router.state.location.pathname;
  const currentInboxId =
    input.previousThreadId ??
    findInboxThread(
      appAtomRegistry.get(environmentThreadShells.environmentThreadsAtom(environmentId)),
      projectId,
    )?.id ??
    null;
  const wasViewingPrevious =
    currentInboxId !== null &&
    isThreadRoutePathname(initialPathname, scopeThreadRef(environmentId, currentInboxId));
  let navigatedDuringReset = false;
  // A missing-thread redirect while reset is in flight uses REPLACE; only user navigation wins.
  const stopWatchingHistory = router.history.subscribe(
    ({ action }: { readonly action: { readonly type: string } }) => {
      if (action.type !== "REPLACE") navigatedDuringReset = true;
    },
  );

  try {
    const result = await runAtomCommand(
      appAtomRegistry,
      inboxAgentReset,
      { environmentId, input: { projectId } },
      { reportFailure: false },
    );
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to reset Inbox",
            description: inboxAgentResetFailureMessage(squashAtomCommandFailure(result)),
          }),
        );
      }
      return false;
    }

    const { threadId: nextThreadId, previousThreadId } = result.value;
    if (previousThreadId !== null) {
      clearResetInboxThreadState(scopeThreadRef(environmentId, previousThreadId));
    }
    const shouldNavigate =
      !navigatedDuringReset &&
      (wasViewingPrevious ||
        (previousThreadId !== null &&
          isThreadRoutePathname(initialPathname, scopeThreadRef(environmentId, previousThreadId))));
    if (shouldNavigate) {
      await router.navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(scopeThreadRef(environmentId, nextThreadId)),
        replace: true,
      });
    }
    toastManager.add(
      stackedThreadToast({
        type: "success",
        title: "Inbox reset",
        description: "Started a new Inbox thread.",
      }),
    );
    return true;
  } finally {
    stopWatchingHistory();
    const after = new Set(appAtomRegistry.get(resettingProjectsAtom));
    after.delete(key);
    appAtomRegistry.set(resettingProjectsAtom, after);
  }
}

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

export interface ResetInboxHandle {
  readonly canReset: boolean;
  readonly resetting: boolean;
  readonly reset: () => Promise<boolean>;
}

/** Resets a project's Inbox thread from any UI entry point. */
export function useResetInbox(
  project: ScopedProjectRef | null,
  options?: {
    readonly projectDisplayName?: string | null | undefined;
    readonly threadId?: ThreadId | null | undefined;
  },
): ResetInboxHandle {
  const environmentId = project?.environmentId ?? NO_ENVIRONMENT;
  const hasPermission = useAtomValue(inboxAgentReset.permissionAtom(environmentId));
  const resettingProjects = useAtomValue(resettingProjectsAtom);
  const router = useRouter();
  const resetting =
    project !== null && resettingProjects.has(resetProjectKey(environmentId, project.projectId));
  const canReset = project !== null && hasPermission && !resetting;

  const reset = useStableCallback(async () => {
    if (project === null) return false;
    return resetInboxProject({
      environmentId: project.environmentId,
      projectId: project.projectId,
      projectDisplayName: options?.projectDisplayName,
      previousThreadId: options?.threadId,
      router,
    });
  });

  return { canReset, resetting, reset };
}

/** Whether a thread is a project's Inbox, for views that have only its id. */
export function useIsInboxThread(environmentId: EnvironmentId, threadId: ThreadId): boolean {
  const shell = useAtomValue(environmentThreadShells.environmentThreadIndexAtom(environmentId)).get(
    threadId,
  );
  return isInboxThreadShell(shell);
}
