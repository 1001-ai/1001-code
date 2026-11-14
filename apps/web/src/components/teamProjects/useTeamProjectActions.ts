import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  AuthSourceControlWriteScope,
  type EnvironmentId,
  type ProjectId,
} from "@t3tools/contracts";
import { useState } from "react";

import { useHandleNewThread } from "../../hooks/useHandleNewThread";
import { newProjectId } from "../../lib/utils";
import { waitForProject } from "../../state/entities";
import { projectEnvironment } from "../../state/projects";
import { readEnvironmentScope } from "../../state/session";
import { sourceControlEnvironment } from "../../state/sourceControl";
import { teamCatalogRefresh } from "../../state/teamCatalog";
import { useAtomCommand } from "../../state/use-atom-command";
import { stackedThreadToast, toastManager } from "../ui/toast";

function failureText(error: unknown): string {
  return error instanceof Error ? error.message : "An error occurred.";
}

function toastError(title: string, description: string): void {
  toastManager.add(stackedThreadToast({ type: "error", title, description }));
}

/** Opens a team project that is already here, or clones or adopts its checkout and opens it. */
export function useTeamProjectActions(input: {
  readonly environmentId: EnvironmentId | null;
  /** Runs before navigating to the opened project, such as closing a palette. */
  readonly beforeOpen?: () => void;
}) {
  const { environmentId, beforeOpen } = input;
  const { handleNewThread } = useHandleNewThread();
  const refresh = useAtomCommand(teamCatalogRefresh, { reportFailure: false });
  const createProject = useAtomCommand(projectEnvironment.create, { reportFailure: false });
  const startProjectClone = useAtomCommand(sourceControlEnvironment.startProjectClone, {
    reportFailure: false,
  });
  const [addingKey, setAddingKey] = useState<string | null>(null);

  const openProject = async (projectId: ProjectId) => {
    if (environmentId === null) return;
    beforeOpen?.();
    const ref = scopeProjectRef(environmentId, projectId);
    await waitForProject(ref, 3_000).catch(() => null);
    const opened = await settlePromise(() => handleNewThread(ref));
    if (opened._tag === "Failure") {
      toastError("Failed to open project", failureText(squashAtomCommandFailure(opened)));
    }
  };

  const addProjectUnguarded = async (key: string) => {
    if (environmentId === null) return;
    if (!readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)) {
      toastError("Cannot add project", "This connection cannot add projects.");
      return;
    }
    // Re-read the checkout first: what is on disk may have changed since the list arrived.
    const refreshed = await refresh({ environmentId, input: {} });
    if (refreshed._tag === "Failure") {
      toastError("Team catalog unavailable", failureText(squashAtomCommandFailure(refreshed)));
      return;
    }
    const entry = refreshed.value.projects.find((candidate) => candidate.project.key === key);
    if (entry === undefined) {
      toastError("Project not found", "It is no longer in the team catalog.");
      return;
    }
    if (entry.checkout.state === "occupied") {
      toastError("Cannot add project", `${entry.checkout.path} already holds another folder.`);
      return;
    }
    if (
      entry.checkout.state === "missing" &&
      !readEnvironmentScope(environmentId, AuthSourceControlWriteScope)
    ) {
      toastError("Clone unavailable", "This connection cannot clone repositories.");
      return;
    }
    const projectId = newProjectId();
    const result =
      entry.checkout.state === "present"
        ? await createProject({
            environmentId,
            input: {
              projectId,
              title: entry.project.name,
              workspaceRoot: entry.checkout.path,
              createWorkspaceRootIfMissing: false,
              defaultModelSelection: null,
            },
          })
        : await startProjectClone({
            environmentId,
            input: {
              projectId,
              title: entry.project.name,
              createdAt: new Date().toISOString(),
              remoteUrl: entry.cloneUrl,
              destinationPath: entry.checkout.path,
            },
          });
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        toastError("Failed to add project", failureText(squashAtomCommandFailure(result)));
      }
      return;
    }
    await openProject(projectId);
  };

  const addProject = async (key: string) => {
    setAddingKey(key);
    await addProjectUnguarded(key);
    setAddingKey(null);
  };

  return { openProject, addProject, addingKey };
}
