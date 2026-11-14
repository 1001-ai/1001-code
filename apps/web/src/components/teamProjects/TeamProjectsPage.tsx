import {
  type EnvironmentId,
  matchTeamCatalogProjects,
  type ProjectId,
  resolveTeamProjectGraph,
  type TeamCatalogEntry,
  type TeamCatalogSnapshot,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { FolderCheckIcon, FolderDownIcon, RefreshCwIcon, SettingsIcon } from "lucide-react";
import { useState } from "react";

import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { useProjects } from "../../state/entities";
import { teamCatalogRefresh, useTeamCatalog } from "../../state/teamCatalog";
import { useAtomCommand } from "../../state/use-atom-command";
import { AppRouteModal, AppRouteModalClose } from "../AppRouteModal";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { TeamProjectGraph } from "./TeamProjectGraph";
import { TeamProjectLinksEditor } from "./TeamProjectLinksEditor";
import { useTeamProjectActions } from "./useTeamProjectActions";

function Legend() {
  const line = (dash: string | undefined, className: string, width: number) => (
    <svg width="28" height="8" aria-hidden className="shrink-0">
      <line
        x1="1"
        y1="4"
        x2="27"
        y2="4"
        strokeWidth={width}
        strokeDasharray={dash}
        className={className}
      />
    </svg>
  );
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
      <span className="flex items-center gap-1.5">
        {line("5 4", "stroke-muted-foreground", 1.25)}
        Reads
      </span>
      <span className="flex items-center gap-1.5">
        {line(undefined, "stroke-foreground", 2)}
        Writes, both sides agreed
      </span>
      <span className="flex items-center gap-1.5">
        {line(undefined, "stroke-foreground opacity-35", 2)}
        Write pending the other side
      </span>
      <span className="flex items-center gap-1.5">
        {line("5 4", "stroke-warning", 1.25)}
        No access
      </span>
    </div>
  );
}

function SelectedProject(props: {
  readonly environmentId: EnvironmentId;
  readonly snapshot: TeamCatalogSnapshot;
  readonly entry: TeamCatalogEntry;
  readonly localProjectId: ProjectId | null;
  readonly actions: ReturnType<typeof useTeamProjectActions>;
}) {
  const { entry, localProjectId, actions } = props;
  const adding = actions.addingKey === entry.project.key;
  return (
    <div className="space-y-1">
      <div className="space-y-2 px-3 pt-3 sm:px-4">
        <h2 className="text-base font-semibold">{entry.project.name}</h2>
        <p className="break-all text-xs text-muted-foreground">{entry.project.repo}</p>
        {localProjectId !== null ? (
          <Button size="sm" onClick={() => void actions.openProject(localProjectId)}>
            <FolderCheckIcon />
            Open project
          </Button>
        ) : entry.checkout.state === "occupied" ? (
          <p className="text-xs text-warning-foreground">
            {entry.checkout.path} holds another folder, so it cannot be added here.
          </p>
        ) : (
          <Button
            size="sm"
            variant="outline"
            disabled={actions.addingKey !== null}
            onClick={() => void actions.addProject(entry.project.key)}
          >
            <FolderDownIcon />
            {adding
              ? "Adding…"
              : entry.checkout.state === "present"
                ? "Add the existing checkout"
                : "Clone and add"}
          </Button>
        )}
      </div>
      <TeamProjectLinksEditor
        environmentId={props.environmentId}
        snapshot={props.snapshot}
        projectKey={entry.project.key}
      />
    </div>
  );
}

/** Every team project in the environment's catalog, grouped by parent, with their links. */
export function TeamProjectsPage() {
  const navigate = useNavigate();
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const [chosenEnvironmentId, setChosenEnvironmentId] = useState<EnvironmentId | null>(null);
  const environmentId =
    environments.find((environment) => environment.environmentId === chosenEnvironmentId)
      ?.environmentId ??
    primaryEnvironmentId ??
    environments[0]?.environmentId ??
    null;
  const snapshot = useTeamCatalog(environmentId);
  const projects = useProjects();
  const refresh = useAtomCommand(teamCatalogRefresh);
  const actions = useTeamProjectActions({ environmentId });
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  const entries = snapshot?.projects ?? [];
  const matches = matchTeamCatalogProjects(
    entries,
    projects.filter((project) => project.environmentId === environmentId),
  );
  const localByKey = new Map(
    matches.map(({ entry, localProject }) => [entry.project.key, localProject?.id ?? null]),
  );
  const reachableByKey = new Map(entries.map((entry) => [entry.project.key, entry.reachable]));
  const graph = resolveTeamProjectGraph(
    entries.map((entry) => entry.project),
    (key) => reachableByKey.get(key) ?? null,
  );
  const captions = new Map(
    entries.map((entry) => [
      entry.project.key,
      localByKey.get(entry.project.key) != null
        ? "Added"
        : entry.reachable === false
          ? "No access"
          : entry.checkout.state === "present"
            ? "Checked out, not added"
            : "Not added",
    ]),
  );
  const selected = entries.find((entry) => entry.project.key === selectedKey) ?? null;
  const environmentLabel = (id: EnvironmentId | null) =>
    environments.find((environment) => environment.environmentId === id)?.label ?? "Environment";

  const openSettings = () => void navigate({ to: "/settings/threads", hash: "team-catalog" });

  return (
    <AppRouteModal label="Team projects">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex min-h-12 shrink-0 items-center gap-2 border-b ps-5 pe-2">
          <h1 className="min-w-0 flex-1 truncate text-sm font-medium">Team projects</h1>
          {environments.length > 1 ? (
            <Select
              value={environmentId ?? ""}
              onValueChange={(value) => {
                setSelectedKey(null);
                setChosenEnvironmentId(
                  environments.find((environment) => environment.environmentId === value)
                    ?.environmentId ?? null,
                );
              }}
            >
              <SelectTrigger size="xs" className="w-auto min-w-0" aria-label="Environment">
                <SelectValue>{environmentLabel(environmentId)}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {environments.map((environment) => (
                  <SelectItem
                    hideIndicator
                    key={environment.environmentId}
                    value={environment.environmentId}
                  >
                    {environment.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Fetch team catalog"
            disabled={environmentId === null || snapshot?.source == null || snapshot.refreshing}
            onClick={() => {
              if (environmentId !== null) void refresh({ environmentId, input: { force: true } });
            }}
          >
            <RefreshCwIcon />
          </Button>
          <AppRouteModalClose />
        </header>

        {environmentId === null || snapshot === null ? (
          <p className="p-6 text-sm text-muted-foreground">
            {environmentId === null ? "Connect an environment to see team projects." : "Loading…"}
          </p>
        ) : snapshot.source === null ? (
          <div className="flex flex-col items-start gap-3 p-6">
            <p className="text-sm text-muted-foreground">
              No team catalog is set for {environmentLabel(environmentId)}. A team catalog is a git
              repository with one file per project.
            </p>
            <Button size="sm" variant="outline" onClick={openSettings}>
              <SettingsIcon />
              Set up a team catalog
            </Button>
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col md:flex-row">
            <ScrollArea className="min-h-0 min-w-0 flex-1">
              <div className="space-y-3 p-4">
                <Legend />
                {snapshot.error !== null ? (
                  <Alert variant="warning">
                    <AlertDescription>
                      The latest fetch failed, so this is the last fetched catalog: {snapshot.error}
                    </AlertDescription>
                  </Alert>
                ) : null}
                {graph.issues.length > 0 || snapshot.invalid.length > 0 ? (
                  <Alert variant="warning">
                    <AlertDescription>
                      {snapshot.invalid.length > 0
                        ? `${snapshot.invalid.length} catalog file${snapshot.invalid.length === 1 ? " was" : "s were"} skipped as invalid. `
                        : ""}
                      {graph.issues.length > 0
                        ? `${graph.issues.length} link or grouping problem${graph.issues.length === 1 ? "" : "s"}; select a project to see them.`
                        : ""}
                    </AlertDescription>
                  </Alert>
                ) : null}
                {entries.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    {snapshot.refreshing ? "Fetching…" : "The catalog lists no projects yet."}
                  </p>
                ) : (
                  <TeamProjectGraph
                    projects={entries.map((entry) => entry.project)}
                    links={graph.links}
                    captions={captions}
                    selectedKey={selected?.project.key ?? null}
                    onSelect={setSelectedKey}
                  />
                )}
              </div>
            </ScrollArea>
            {selected !== null ? (
              <aside className="max-h-[50%] shrink-0 overflow-y-auto border-t md:max-h-none md:w-96 md:border-t-0 md:border-l">
                <SelectedProject
                  environmentId={environmentId}
                  snapshot={snapshot}
                  entry={selected}
                  localProjectId={localByKey.get(selected.project.key) ?? null}
                  actions={actions}
                />
              </aside>
            ) : null}
          </div>
        )}
      </div>
    </AppRouteModal>
  );
}
