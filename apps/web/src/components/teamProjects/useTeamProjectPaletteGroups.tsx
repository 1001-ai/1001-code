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
  matchTeamCatalogProjects,
  type TeamCatalogEntry,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { FolderCheckIcon, FolderDownIcon, TriangleAlertIcon } from "lucide-react";
import { useState } from "react";

import { useHandleNewThread } from "../../hooks/useHandleNewThread";
import { newProjectId } from "../../lib/utils";
import { useProjects, waitForProject } from "../../state/entities";
import { projectEnvironment } from "../../state/projects";
import { readEnvironmentScope } from "../../state/session";
import { sourceControlEnvironment } from "../../state/sourceControl";
import { teamCatalogRefresh, useTeamCatalog } from "../../state/teamCatalog";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  type CommandPaletteActionItem,
  type CommandPaletteGroup,
  ITEM_ICON_CLASS,
} from "../CommandPalette.logic";
import { stackedThreadToast, toastManager } from "../ui/toast";

function failureText(error: unknown): string {
  return error instanceof Error ? error.message : "An error occurred.";
}

function toastError(title: string, description: string): void {
  toastManager.add(stackedThreadToast({ type: "error", title, description }));
}

/**
 * The "Team projects" group of the add-project sources view: the environment's team catalog,
 * marked where a project with the same repository is already here, with Add for the rest.
 */
export function useTeamProjectPaletteGroups(input: {
  readonly environmentId: EnvironmentId | null;
  readonly closePalette: () => void;
}): ReadonlyArray<CommandPaletteGroup> {
  const { environmentId, closePalette } = input;
  const catalog = useTeamCatalog(environmentId);
  const projects = useProjects();
  const navigate = useNavigate();
  const { handleNewThread } = useHandleNewThread();
  const refresh = useAtomCommand(teamCatalogRefresh, { reportFailure: false });
  const createProject = useAtomCommand(projectEnvironment.create, { reportFailure: false });
  const startProjectClone = useAtomCommand(sourceControlEnvironment.startProjectClone, {
    reportFailure: false,
  });
  const [addingKey, setAddingKey] = useState<string | null>(null);

  if (environmentId === null || catalog === null || catalog.source === null) return [];

  const openProject = async (projectId: Parameters<typeof scopeProjectRef>[1]) => {
    closePalette();
    const ref = scopeProjectRef(environmentId, projectId);
    await waitForProject(ref, 3_000).catch(() => null);
    const opened = await settlePromise(() => handleNewThread(ref));
    if (opened._tag === "Failure") {
      toastError("Failed to open project", failureText(squashAtomCommandFailure(opened)));
    }
  };

  const addProject = async (key: string) => {
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
              // oxlint-disable-next-line react/purity -- runs in an event handler (oxc#27309)
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

  const entryItem = (
    entry: TeamCatalogEntry,
    localProjectId: Parameters<typeof scopeProjectRef>[1] | null,
  ): CommandPaletteActionItem => {
    const base = {
      kind: "action" as const,
      value: `action:team-project:${environmentId}:${entry.project.key}`,
      searchTerms: ["team", "catalog", entry.project.name, entry.project.key, entry.project.repo],
      title: entry.project.name,
    };
    if (localProjectId !== null) {
      return {
        ...base,
        description: `${entry.project.repo} · Added`,
        icon: <FolderCheckIcon className={ITEM_ICON_CLASS} />,
        run: () => openProject(localProjectId),
      };
    }
    if (entry.checkout.state === "occupied") {
      return {
        ...base,
        description: `${entry.project.repo} · Its folder holds something else`,
        disabled: true,
        icon: <TriangleAlertIcon className={ITEM_ICON_CLASS} />,
        run: async () => {},
      };
    }
    const adding = addingKey === entry.project.key;
    return {
      ...base,
      description: adding
        ? "Adding…"
        : entry.checkout.state === "present"
          ? `${entry.project.repo} · Add the existing checkout`
          : `${entry.project.repo} · Clone and add`,
      disabled: addingKey !== null,
      icon: <FolderDownIcon className={ITEM_ICON_CLASS} />,
      keepOpen: true,
      run: async () => {
        setAddingKey(entry.project.key);
        await addProject(entry.project.key);
        setAddingKey(null);
      },
    };
  };

  const openSettings: CommandPaletteActionItem = {
    kind: "action",
    value: `action:team-project:${environmentId}:settings`,
    searchTerms: ["team", "catalog", "settings"],
    title: catalog.error !== null ? "Team catalog could not be fetched" : "Team catalog",
    description:
      catalog.error ??
      `${catalog.invalid.length} file${catalog.invalid.length === 1 ? "" : "s"} skipped as invalid`,
    icon: <TriangleAlertIcon className={ITEM_ICON_CLASS} />,
    run: async () => {
      closePalette();
      await navigate({ to: "/settings/threads", hash: "team-catalog" });
    },
  };

  const environmentProjects = projects.filter((project) => project.environmentId === environmentId);
  const items = matchTeamCatalogProjects(catalog.projects, environmentProjects).map(
    ({ entry, localProject }) => entryItem(entry, localProject?.id ?? null),
  );
  if (catalog.error !== null || catalog.invalid.length > 0) items.push(openSettings);
  if (items.length === 0) return [];
  return [{ value: `team-projects:${environmentId}`, label: "Team projects", items }];
}
