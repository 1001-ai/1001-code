import "@xyflow/react/dist/base.css";

import { type TeamCatalogProject, type TeamProjectLink } from "@t3tools/contracts";
import {
  Background,
  BackgroundVariant,
  type EdgeProps,
  type EdgeTypes,
  Handle,
  type NodeProps,
  type NodeTypes,
  Panel,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
} from "@xyflow/react";
import ElkConstructor, { type ELK, type ElkNode } from "elkjs/lib/elk-api.js";
import elkWorkerUrl from "elkjs/lib/elk-worker.min.js?url";
import { ScanIcon, ZoomInIcon, ZoomOutIcon } from "lucide-react";
import { createContext, type KeyboardEvent, use, useEffect, useRef, useState } from "react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import {
  type DrawnLink,
  drawnTeamProjectLinks,
  type ProjectCardNode,
  type RoutedEdge,
  roundedPath,
  type TeamProjectFlow,
  type TeamProjectFlowNode,
  teamProjectElkGraph,
  teamProjectFlow,
} from "./teamProjectGraphElk";

const ARROW_ID = "team-project-arrow";
const FIT_VIEW = { padding: 0.12, maxZoom: 1 };
const NO_NODES: Array<TeamProjectFlowNode> = [];
const NO_EDGES: Array<RoutedEdge> = [];

interface ElkWorker {
  readonly elk: ELK;
  /** Rejects when the worker fails to load or crashes; elkjs itself never hears of it. */
  readonly broken: Promise<never>;
}

let elkWorker: ElkWorker | null = null;
function startElkWorker(): ElkWorker {
  const worker = new Worker(elkWorkerUrl);
  const broken = new Promise<never>((_, reject) => {
    worker.addEventListener("error", (event) => {
      elkWorker = null;
      worker.terminate();
      reject(new Error(event.message || "The layout worker failed."));
    });
  });
  return { elk: new ElkConstructor({ workerFactory: () => worker }), broken };
}

function layOut(graph: ElkNode): Promise<ElkNode> {
  elkWorker ??= startElkWorker();
  return Promise.race([elkWorker.elk.layout(graph), elkWorker.broken]);
}

interface GraphView {
  readonly names: ReadonlyMap<string, string>;
  readonly captions: ReadonlyMap<string, string>;
  readonly links: ReadonlyMap<string, DrawnLink>;
  readonly selectedKey: string | null;
  /** The selected project and every project it links with either way. */
  readonly related: ReadonlySet<string>;
  readonly toggle: (key: string) => void;
}

const GraphViewContext = createContext<GraphView | null>(null);

function useGraphView(): GraphView {
  const view = use(GraphViewContext);
  if (view === null) throw new Error("Team project graph nodes render inside TeamProjectGraph.");
  return view;
}

function ProjectCard({ data }: NodeProps<ProjectCardNode>) {
  const view = useGraphView();
  const name = view.names.get(data.key) ?? data.key;
  const selected = view.selectedKey === data.key;
  const dimmed = view.selectedKey !== null && !view.related.has(data.key);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    view.toggle(data.key);
  };
  return (
    <div
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      aria-label={name}
      className={cn(
        "flex size-full cursor-pointer flex-col justify-center gap-0.5 border bg-card px-3 outline-none hover:border-ring focus-visible:border-ring",
        data.header ? "rounded-t-xl" : "rounded-lg",
        selected ? "border-primary ring-1 ring-primary" : "border-border",
        dimmed && "opacity-40",
      )}
      onClick={() => view.toggle(data.key)}
      onKeyDown={onKeyDown}
    >
      <Handle type="target" position={Position.Top} isConnectable={false} className="invisible" />
      <span className="truncate text-sm font-medium text-foreground">{name}</span>
      <span className="truncate text-2xs text-muted-foreground">
        {view.captions.get(data.key) ?? data.key}
      </span>
      <Handle
        type="source"
        position={Position.Bottom}
        isConnectable={false}
        className="invisible"
      />
    </div>
  );
}

function ProjectBox() {
  return <div className="size-full rounded-xl border border-border bg-muted/40" />;
}

function edgeClass(link: TeamProjectLink): string {
  if (link.access === "read") {
    return link.status === "no-access" ? "stroke-warning" : "stroke-muted-foreground";
  }
  return "stroke-foreground";
}

function edgeTitle(drawn: DrawnLink, names: ReadonlyMap<string, string>): string {
  const { link, mutual } = drawn;
  const verb = mutual ? "and" : link.access === "write" ? "writes" : "reads";
  const note = mutual
    ? " write to each other"
    : link.status === "pending"
      ? " (pending the other side)"
      : link.status === "no-access"
        ? " (no access)"
        : "";
  return `${names.get(link.from) ?? link.from} ${verb} ${names.get(link.to) ?? link.to}${note}`;
}

function LinkEdge({ id, data }: EdgeProps<RoutedEdge>) {
  const view = useGraphView();
  const drawn = view.links.get(id);
  if (drawn === undefined || data === undefined) return null;
  const { link } = drawn;
  const highlighted =
    view.selectedKey !== null && (link.from === view.selectedKey || link.to === view.selectedKey);
  const faded = view.selectedKey !== null && !highlighted;
  return (
    <path
      d={roundedPath(data.points)}
      fill="none"
      className={cn(
        "[pointer-events:visibleStroke]",
        highlighted ? "stroke-primary" : edgeClass(link),
        link.status === "pending" && "opacity-35",
        faded && "opacity-15",
      )}
      strokeWidth={link.access === "write" ? 2 : 1.25}
      strokeDasharray={link.access === "read" ? "5 4" : undefined}
      markerEnd={`url(#${ARROW_ID})`}
      markerStart={drawn.mutual ? `url(#${ARROW_ID})` : undefined}
    >
      <title>{edgeTitle(drawn, view.names)}</title>
    </path>
  );
}

const NODE_TYPES: NodeTypes = { project: ProjectCard, projectBox: ProjectBox };
const EDGE_TYPES: EdgeTypes = { routed: LinkEdge };

function ZoomControls() {
  const { zoomIn, zoomOut, fitView } = useReactFlow();
  return (
    <Panel position="top-left" style={{ margin: 6 }}>
      {/* Clears the drawer's taller resize handle on touch screens, as the close button does. */}
      <div className="flex flex-col gap-0.5 rounded-lg border bg-background p-0.5 shadow-xs any-pointer-coarse:mt-3.5">
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label="Zoom in"
          onClick={() => void zoomIn()}
        >
          <ZoomInIcon />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label="Zoom out"
          onClick={() => void zoomOut()}
        >
          <ZoomOutIcon />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label="Fit to view"
          onClick={() => void fitView(FIT_VIEW)}
        >
          <ScanIcon />
        </Button>
      </div>
    </Panel>
  );
}

interface TeamProjectGraphProps {
  readonly projects: ReadonlyArray<TeamCatalogProject>;
  readonly links: ReadonlyArray<TeamProjectLink>;
  /** One short line under each project's name, such as whether it is added here. */
  readonly captions: ReadonlyMap<string, string>;
  readonly selectedKey: string | null;
  readonly onSelect: (key: string | null) => void;
}

/**
 * Team projects as boxes grouped by parent, laid out by ELK in a worker, with read links dashed,
 * write links solid and pending write links faded. It lays out again only when the projects or
 * links change; selecting never moves anything.
 */
export function TeamProjectGraph(props: TeamProjectGraphProps) {
  return (
    <ReactFlowProvider>
      <GraphCanvas {...props} />
    </ReactFlowProvider>
  );
}

function GraphCanvas(props: TeamProjectGraphProps) {
  const { projects, links, captions, selectedKey, onSelect } = props;
  const { fitView } = useReactFlow();
  const [flow, setFlow] = useState<TeamProjectFlow | null>(null);
  const [failed, setFailed] = useState(false);
  const fittedKeys = useRef<string | null>(null);
  const signature = JSON.stringify(teamProjectElkGraph(projects, links));

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- ELK lays the graph out in a worker, so the result arrives asynchronously.
  useEffect(() => {
    let current = true;
    const graph: ElkNode = JSON.parse(signature);
    layOut(graph).then(
      (laidOut) => {
        if (!current) return;
        setFlow(teamProjectFlow(laidOut));
        setFailed(false);
      },
      () => {
        if (!current) return;
        setFlow(null);
        setFailed(true);
      },
    );
    return () => {
      current = false;
    };
  }, [signature]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- fits React Flow's viewport when the drawn projects change, and keeps the reader's viewport otherwise.
  useEffect(() => {
    if (flow === null || fittedKeys.current === flow.keys) return;
    fittedKeys.current = flow.keys;
    void fitView(FIT_VIEW);
  }, [flow, fitView]);

  const keys = new Set(projects.map((project) => project.key));
  const related = new Set<string>();
  if (selectedKey !== null) {
    related.add(selectedKey);
    for (const link of links) {
      if (link.from === selectedKey) related.add(link.to);
      if (link.to === selectedKey) related.add(link.from);
    }
  }
  const view: GraphView = {
    names: new Map(projects.map((project) => [project.key, project.name])),
    captions,
    links: new Map(drawnTeamProjectLinks(links, keys).map((drawn) => [drawn.id, drawn])),
    selectedKey,
    related,
    toggle: (key) => onSelect(selectedKey === key ? null : key),
  };

  return (
    <div className="absolute inset-0">
      <GraphViewContext value={view}>
        <svg aria-hidden className="absolute size-0">
          <defs>
            <marker
              id={ARROW_ID}
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="7"
              markerHeight="7"
              orient="auto-start-reverse"
            >
              <path d="M0,1 L9,5 L0,9 z" fill="context-stroke" />
            </marker>
          </defs>
        </svg>
        <ReactFlow<TeamProjectFlowNode, RoutedEdge>
          aria-label="Team projects and their links"
          nodes={flow?.nodes ?? NO_NODES}
          edges={flow?.edges ?? NO_EDGES}
          nodeTypes={NODE_TYPES}
          edgeTypes={EDGE_TYPES}
          zIndexMode="manual"
          nodesDraggable={false}
          nodesConnectable={false}
          nodesFocusable={false}
          edgesFocusable={false}
          elementsSelectable={false}
          disableKeyboardA11y
          deleteKeyCode={null}
          selectionKeyCode={null}
          multiSelectionKeyCode={null}
          panOnScroll
          zoomOnDoubleClick={false}
          minZoom={0.2}
          maxZoom={2}
          onPaneClick={() => onSelect(null)}
          proOptions={{ hideAttribution: true }}
        >
          <Background
            variant={BackgroundVariant.Dots}
            gap={20}
            size={2}
            color="color-mix(in srgb, var(--color-foreground) 14%, transparent)"
          />
          <ZoomControls />
        </ReactFlow>
        {failed ? (
          // Centred, so the panel's catalog alerts along the top never cover it.
          <p className="pointer-events-none absolute inset-0 grid place-items-center text-sm text-muted-foreground">
            The graph could not be laid out.
          </p>
        ) : null}
      </GraphViewContext>
    </div>
  );
}
