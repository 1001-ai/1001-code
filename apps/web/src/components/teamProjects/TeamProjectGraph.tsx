import { type TeamCatalogProject, type TeamProjectLink } from "@t3tools/contracts";
import { type KeyboardEvent, useState } from "react";

import { observeResize } from "~/lib/observeResize";
import { cn } from "~/lib/utils";
import {
  edgePath,
  type GraphNode,
  layoutTeamProjectGraph,
  NODE_HEIGHT,
  NODE_WIDTH,
} from "./teamProjectGraphLayout";

const MAX_LABEL = 20;

function clip(text: string): string {
  return text.length > MAX_LABEL ? `${text.slice(0, MAX_LABEL - 1)}…` : text;
}

interface DrawnEdge {
  readonly id: string;
  readonly from: GraphNode;
  readonly to: GraphNode;
  readonly link: TeamProjectLink;
  /** Both projects declare this write link, so one edge stands for both. */
  readonly mutual: boolean;
}

function drawnEdges(
  links: ReadonlyArray<TeamProjectLink>,
  nodes: ReadonlyMap<string, GraphNode>,
): ReadonlyArray<DrawnEdge> {
  const edges: Array<DrawnEdge> = [];
  for (const link of links) {
    const from = nodes.get(link.from);
    const to = nodes.get(link.to);
    if (from === undefined || to === undefined) continue;
    const mutual = link.access === "write" && link.status === "active";
    if (mutual && link.from > link.to) continue;
    edges.push({ id: `${link.from}>${link.to}:${link.access}`, from, to, link, mutual });
  }
  return edges;
}

function edgeClass(link: TeamProjectLink): string {
  if (link.access === "read") {
    return link.status === "no-access" ? "stroke-warning" : "stroke-muted-foreground";
  }
  return "stroke-foreground";
}

/**
 * Team projects as boxes grouped by parent, with read links dashed, write links solid and
 * pending write links faded. Static SVG: it repaints only when the catalog or selection changes.
 */
export function TeamProjectGraph(props: {
  readonly projects: ReadonlyArray<TeamCatalogProject>;
  readonly links: ReadonlyArray<TeamProjectLink>;
  /** One short line under each project's name, such as whether it is added here. */
  readonly captions: ReadonlyMap<string, string>;
  readonly selectedKey: string | null;
  readonly onSelect: (key: string | null) => void;
}) {
  const { projects, links, captions, selectedKey, onSelect } = props;
  const [width, setWidth] = useState(960);
  const measure = (element: HTMLDivElement | null) => {
    if (element === null) return;
    return observeResize(element, (entries) => {
      const entry = entries.at(-1);
      if (entry !== undefined) setWidth(Math.round(entry.contentRect.width));
    });
  };

  const layout = layoutTeamProjectGraph(projects, width);
  const edges = drawnEdges(links, layout.nodes);
  const related = new Set<string>();
  if (selectedKey !== null) {
    related.add(selectedKey);
    for (const link of links) {
      if (link.from === selectedKey) related.add(link.to);
      if (link.to === selectedKey) related.add(link.from);
    }
  }
  const names = new Map(projects.map((project) => [project.key, project.name]));
  const touchesSelection = (edge: DrawnEdge) =>
    selectedKey !== null && (edge.link.from === selectedKey || edge.link.to === selectedKey);

  const onNodeKey = (event: KeyboardEvent<SVGGElement>, key: string) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onSelect(selectedKey === key ? null : key);
  };

  return (
    <div ref={measure} className="min-w-0">
      <svg
        width={layout.width}
        height={layout.height}
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        className="block select-none"
        role="group"
        aria-label="Team projects and their links"
        onClick={(event) => {
          if (event.target === event.currentTarget) onSelect(null);
        }}
      >
        <defs>
          <marker
            id="team-project-arrow"
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

        {layout.clusters.map((cluster) => (
          <rect
            key={cluster.key}
            x={cluster.x}
            y={cluster.y}
            width={cluster.width}
            height={cluster.height}
            rx={14}
            className="pointer-events-none fill-muted/40 stroke-border"
            strokeWidth={1}
          />
        ))}

        {edges.map((edge) => {
          const highlighted = touchesSelection(edge);
          const faded = selectedKey !== null && !highlighted;
          return (
            <path
              key={edge.id}
              d={edgePath(edge.from, edge.to)}
              fill="none"
              className={cn(
                highlighted ? "stroke-primary" : edgeClass(edge.link),
                edge.link.status === "pending" && "opacity-35",
                faded && "opacity-15",
              )}
              strokeWidth={edge.link.access === "write" ? 2 : 1.25}
              strokeDasharray={edge.link.access === "read" ? "5 4" : undefined}
              markerEnd="url(#team-project-arrow)"
              markerStart={edge.mutual ? "url(#team-project-arrow)" : undefined}
            >
              <title>
                {`${names.get(edge.link.from) ?? edge.link.from} ${
                  edge.mutual ? "and" : edge.link.access === "write" ? "writes" : "reads"
                } ${names.get(edge.link.to) ?? edge.link.to}${
                  edge.mutual
                    ? " write to each other"
                    : edge.link.status === "pending"
                      ? " (pending the other side)"
                      : edge.link.status === "no-access"
                        ? " (no access)"
                        : ""
                }`}
              </title>
            </path>
          );
        })}

        {projects.map((project) => {
          const node = layout.nodes.get(project.key);
          if (node === undefined) return null;
          const selected = selectedKey === project.key;
          const dimmed = selectedKey !== null && !related.has(project.key);
          return (
            <g
              key={project.key}
              transform={`translate(${node.x},${node.y})`}
              role="button"
              tabIndex={0}
              aria-pressed={selected}
              aria-label={project.name}
              className={cn("group cursor-pointer outline-none", dimmed && "opacity-40")}
              onClick={() => onSelect(selected ? null : project.key)}
              onKeyDown={(event) => onNodeKey(event, project.key)}
            >
              <rect
                width={NODE_WIDTH}
                height={NODE_HEIGHT}
                rx={9}
                className={cn(
                  "fill-card group-hover:stroke-ring group-focus-visible:stroke-ring",
                  selected ? "stroke-primary" : "stroke-border",
                )}
                strokeWidth={selected ? 2 : 1}
              />
              <text x={12} y={20} className="fill-foreground text-sm font-medium">
                {clip(project.name)}
              </text>
              <text x={12} y={37} className="fill-muted-foreground text-2xs">
                {clip(captions.get(project.key) ?? project.key)}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
