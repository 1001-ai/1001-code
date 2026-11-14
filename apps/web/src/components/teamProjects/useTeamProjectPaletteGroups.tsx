import {
  type EnvironmentId,
  matchTeamCatalogProjects,
  type ProjectId,
  type TeamCatalogEntry,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { FolderCheckIcon, FolderDownIcon, TriangleAlertIcon } from "lucide-react";

import { useProjects } from "../../state/entities";
import { useTeamCatalog } from "../../state/teamCatalog";
import {
  type CommandPaletteActionItem,
  type CommandPaletteGroup,
  ITEM_ICON_CLASS,
} from "../CommandPalette.logic";
import { useTeamProjectActions } from "./useTeamProjectActions";

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
  const { openProject, addProject, addingKey } = useTeamProjectActions({
    environmentId,
    beforeOpen: closePalette,
  });

  if (environmentId === null || catalog === null || catalog.source === null) return [];

  const entryItem = (
    entry: TeamCatalogEntry,
    localProjectId: ProjectId | null,
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
      run: () => addProject(entry.project.key),
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
