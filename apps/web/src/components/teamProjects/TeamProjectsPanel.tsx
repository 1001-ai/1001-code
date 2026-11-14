import {
  type EnvironmentId,
  matchTeamCatalogProjects,
  type ProjectId,
  resolveTeamProjectGraph,
  type TeamCatalogEntry,
  type TeamCatalogSnapshot,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { FolderCheckIcon, FolderDownIcon, RefreshCwIcon, SettingsIcon, XIcon } from "lucide-react";
import { type PointerEvent as ReactPointerEvent, useRef, useState } from "react";

import { observeResize } from "../../lib/observeResize";
import { workspaceAreaProps } from "../../lib/workspaceFocus";
import { useEnvironments } from "../../state/environments";
import { useProjects } from "../../state/entities";
import { teamCatalogRefresh, useTeamCatalog } from "../../state/teamCatalog";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  chatColumnOf,
  clampDrawerHeight,
  readDrawerLayout,
  resolveTerminalDrawerMaxHeight,
} from "../ThreadTerminalDrawer";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { TeamProjectGraph } from "./TeamProjectGraph";
import { TeamProjectLinksEditor } from "./TeamProjectLinksEditor";
import { useTeamProjectsDrawerStore } from "./teamProjectsDrawerState";
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
      <div className="space-y-2 px-3 pt-3">
        <h2 className="text-sm font-semibold">{entry.project.name}</h2>
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
        key={`${props.environmentId}:${entry.project.key}`}
        environmentId={props.environmentId}
        snapshot={props.snapshot}
        projectKey={entry.project.key}
      />
    </div>
  );
}

const DRAG_HEIGHT_PROPERTY = "--team-projects-drawer-drag-height";

/** The drawer that holds the graph: resizes like the terminal drawer, with the same limits. */
export default function TeamProjectsDrawerPanel(props: {
  readonly threadEnvironmentId: EnvironmentId;
  readonly composerHeight: number;
}) {
  const storedHeight = useTeamProjectsDrawerStore((state) => state.height);
  const setStoredHeight = useTeamProjectsDrawerStore((state) => state.setHeight);
  const setOpen = useTeamProjectsDrawerStore((state) => state.setOpen);
  const [layout, setLayout] = useState(() => readDrawerLayout(null));
  const maxHeight = resolveTerminalDrawerMaxHeight({
    ...layout,
    composerHeight: props.composerHeight,
  });
  const height = clampDrawerHeight(storedHeight, maxHeight);
  // Like the terminal drawer, a drag writes only the style and stores the height on release.
  const dragRef = useRef<{
    pointerId: number;
    startY: number;
    startHeight: number;
    height: number;
    drawer: HTMLElement | null;
  } | null>(null);

  const measure = (element: HTMLElement | null) => {
    if (element === null) return;
    const column = chatColumnOf(element);
    const update = () => {
      const next = readDrawerLayout(column);
      setLayout((previous) =>
        previous.viewportHeight === next.viewportHeight &&
        previous.chatColumnHeight === next.chatColumnHeight &&
        previous.headerHeight === next.headerHeight
          ? previous
          : next,
      );
    };
    update();
    const header = column?.querySelector<HTMLElement>("[data-chat-header]");
    const stopObserving = column
      ? observeResize(header ? [column, header] : column, update)
      : undefined;
    window.addEventListener("resize", update);
    return () => {
      stopObserving?.();
      window.removeEventListener("resize", update);
    };
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startHeight: height,
      height,
      drawer: event.currentTarget.parentElement,
    };
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    const next = clampDrawerHeight(drag.startHeight + (drag.startY - event.clientY), maxHeight);
    if (next === drag.height) return;
    drag.height = next;
    drag.drawer?.style.setProperty(DRAG_HEIGHT_PROPERTY, `${next}px`);
  };
  const onPointerEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    drag.drawer?.style.removeProperty(DRAG_HEIGHT_PROPERTY);
    if (drag.height !== drag.startHeight) setStoredHeight(drag.height);
  };

  return (
    <aside
      ref={measure}
      {...workspaceAreaProps("team-projects", 6, "Team projects")}
      data-team-projects-drawer
      className="relative z-45 flex min-w-0 shrink-0 flex-col overflow-hidden border-t border-border/80 bg-background"
      style={{ height: `var(${DRAG_HEIGHT_PROPERTY}, ${height}px)` }}
    >
      <div
        className="absolute inset-x-0 top-0 z-20 h-1.5 cursor-row-resize touch-none any-pointer-coarse:h-4"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        onLostPointerCapture={onPointerEnd}
      />
      <TeamProjectsView
        threadEnvironmentId={props.threadEnvironmentId}
        onClose={() => setOpen(false)}
      />
    </aside>
  );
}

/** Every team project in the environment's catalog, grouped by parent, with their links. */
function TeamProjectsView(props: {
  readonly threadEnvironmentId: EnvironmentId;
  readonly onClose: () => void;
}) {
  const navigate = useNavigate();
  const { environments } = useEnvironments();
  const [chosenEnvironmentId, setChosenEnvironmentId] = useState<EnvironmentId | null>(null);
  const environmentId =
    environments.find((environment) => environment.environmentId === chosenEnvironmentId)
      ?.environmentId ?? props.threadEnvironmentId;
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
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex min-h-9 shrink-0 items-center gap-1 border-b ps-3 pe-1">
        <h2 className="min-w-0 flex-1 truncate text-xs font-medium">Team projects</h2>
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
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Close team projects"
          onClick={props.onClose}
        >
          <XIcon />
        </Button>
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
        <div className="flex min-h-0 flex-1">
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
            <div className="w-80 max-w-[50%] shrink-0 overflow-y-auto border-l">
              <SelectedProject
                environmentId={environmentId}
                snapshot={snapshot}
                entry={selected}
                localProjectId={localByKey.get(selected.project.key) ?? null}
                actions={actions}
              />
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
