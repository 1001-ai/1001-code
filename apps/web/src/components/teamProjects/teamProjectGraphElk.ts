import type { TeamProjectLink } from "@t3tools/contracts";
import type { Edge, Node, XYPosition } from "@xyflow/react";
import type { ElkNode } from "elkjs/lib/elk-api.js";

const CARD_WIDTH = 176;
const CARD_HEIGHT = 52;
const GROUP_PREFIX = "group:";
const COMPONENT_PREFIX = "component:";

// React Flow runs with zIndexMode "manual": boxes under edges, edges under every card, so an
// edge entering a box passes beneath its header card instead of over the project's name. React
// Flow still lifts a nested box one above its parent box, so edges sit far above any box depth.
const BOX_Z = 0;
const EDGE_Z = 1000;
const CARD_Z = 1001;

// Each connected set of top-level projects is laid out on its own with `layered`, and
// `rectpacking` wraps those sets into rows. With INCLUDE_CHILDREN, layered alone puts every
// unlinked project in one long row.
const ROOT_OPTIONS = {
  "elk.algorithm": "rectpacking",
  "elk.aspectRatio": "3",
  "elk.spacing.nodeNode": "48",
  "elk.padding": "[top=0,left=0,bottom=0,right=0]",
  // Children relative to their parent, as React Flow's `parentId` wants; edge points absolute.
  "elk.json.shapeCoords": "PARENT",
  "elk.json.edgeCoords": "ROOT",
};
const COMPONENT_OPTIONS = {
  "elk.algorithm": "layered",
  "elk.direction": "DOWN",
  "elk.hierarchyHandling": "INCLUDE_CHILDREN",
  "elk.edgeRouting": "ORTHOGONAL",
  "elk.padding": "[top=0,left=0,bottom=0,right=0]",
  "elk.spacing.nodeNode": "32",
  "elk.layered.spacing.nodeNodeBetweenLayers": "48",
  "elk.spacing.edgeNode": "16",
  "elk.spacing.edgeEdge": "12",
  "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
};
const GROUP_OPTIONS = {
  "elk.padding": `[top=${CARD_HEIGHT + 24},left=16,bottom=16,right=16]`,
};

interface GraphProjectInput {
  readonly key: string;
  readonly parent?: string | undefined;
}

export interface DrawnLink {
  readonly id: string;
  readonly link: TeamProjectLink;
  /** Both projects declare this write link, so one edge stands for both. */
  readonly mutual: boolean;
}

/** The links drawn as edges: an agreed write link is one edge for both directions. */
export function drawnTeamProjectLinks(
  links: ReadonlyArray<TeamProjectLink>,
  keys: ReadonlySet<string>,
): ReadonlyArray<DrawnLink> {
  const drawn: Array<DrawnLink> = [];
  for (const link of links) {
    if (!keys.has(link.from) || !keys.has(link.to)) continue;
    const mutual = link.access === "write" && link.status === "active";
    if (mutual && link.from > link.to) continue;
    drawn.push({ id: `${link.from}>${link.to}:${link.access}`, link, mutual });
  }
  return drawn;
}

/**
 * The ELK graph for the catalog. A project with children is a box holding them; a parent that
 * is unknown or part of a loop makes the project top-level, so every project is drawn once.
 */
export function teamProjectElkGraph(
  projects: ReadonlyArray<GraphProjectInput>,
  links: ReadonlyArray<TeamProjectLink>,
): ElkNode {
  const keys = new Set(projects.map((project) => project.key));
  const parentOf = new Map(projects.map((project) => [project.key, project.parent]));
  const reachesRoot = (key: string) => {
    const seen = new Set<string>();
    let current: string | undefined = key;
    while (current !== undefined && keys.has(current)) {
      if (seen.has(current)) return false;
      seen.add(current);
      current = parentOf.get(current);
    }
    return true;
  };
  const children = new Map<string, Array<string>>();
  const roots: Array<string> = [];
  const rootOf = new Map<string, string>();
  for (const project of projects) {
    const parent = project.parent;
    if (parent !== undefined && keys.has(parent) && reachesRoot(project.key)) {
      children.set(parent, [...(children.get(parent) ?? []), project.key]);
    } else {
      roots.push(project.key);
    }
  }
  const toElk = (key: string, root: string): ElkNode => {
    rootOf.set(key, root);
    const kids = children.get(key) ?? [];
    return kids.length === 0
      ? { id: key, width: CARD_WIDTH, height: CARD_HEIGHT }
      : { id: key, layoutOptions: GROUP_OPTIONS, children: kids.map((kid) => toElk(kid, root)) };
  };
  const trees = roots.map((root) => toElk(root, root));

  const drawn = drawnTeamProjectLinks(links, keys);
  const componentOf = new Map(roots.map((root) => [root, root]));
  const find = (root: string): string => {
    const next = componentOf.get(root) ?? root;
    return next === root ? root : find(next);
  };
  for (const { link } of drawn) {
    const from = find(rootOf.get(link.from) ?? link.from);
    const to = find(rootOf.get(link.to) ?? link.to);
    if (from !== to) componentOf.set(to, from);
  }
  const components = new Map<string, { trees: Array<ElkNode>; edges: Array<DrawnLink> }>();
  for (const tree of trees) {
    const component = find(tree.id);
    const entry = components.get(component) ?? { trees: [], edges: [] };
    entry.trees.push(tree);
    components.set(component, entry);
  }
  for (const edge of drawn) {
    components.get(find(rootOf.get(edge.link.from) ?? edge.link.from))?.edges.push(edge);
  }
  // Linked or grouped projects first, then the lone ones, each in catalog order.
  const ordered = [...components.values()].toSorted(
    (left, right) => Number(isLone(left)) - Number(isLone(right)),
  );
  return {
    id: "root",
    layoutOptions: ROOT_OPTIONS,
    children: ordered.map((component, index) => ({
      id: `${COMPONENT_PREFIX}${index}`,
      layoutOptions: COMPONENT_OPTIONS,
      children: component.trees,
      edges: component.edges.map((edge) => ({
        id: edge.id,
        sources: [edge.link.from],
        targets: [edge.link.to],
      })),
    })),
  };
}

function isLone(component: {
  readonly trees: ReadonlyArray<ElkNode>;
  readonly edges: ReadonlyArray<DrawnLink>;
}): boolean {
  return (
    component.trees.length === 1 &&
    component.edges.length === 0 &&
    component.trees[0]?.children === undefined
  );
}

export type ProjectCardNode = Node<{ readonly key: string; readonly header: boolean }, "project">;
type ProjectBoxNode = Node<{ readonly key: string }, "projectBox">;
export type TeamProjectFlowNode = ProjectCardNode | ProjectBoxNode;
export type RoutedEdge = Edge<{ readonly points: ReadonlyArray<XYPosition> }, "routed">;

export interface TeamProjectFlow {
  readonly nodes: Array<TeamProjectFlowNode>;
  readonly edges: Array<RoutedEdge>;
  /** The drawn project keys, sorted, to tell a changed catalog from a changed link. */
  readonly keys: string;
}

// React Flow sets `pointer-events: none` on nodes that are neither selectable nor draggable and
// have no node handlers; cards handle their own clicks, so they take pointer events back.
const CARD_STYLE = { pointerEvents: "all" } as const;

/**
 * React Flow nodes and edges from ELK's result. A box's header is the project's own card, a
 * child of the box at its top. Parents come before their children, as React Flow requires.
 */
export function teamProjectFlow(laidOut: ElkNode): TeamProjectFlow {
  const nodes: Array<TeamProjectFlowNode> = [];
  const edges: Array<RoutedEdge> = [];
  const keys: Array<string> = [];
  const place = (node: ElkNode, parentId: string | undefined, offset: XYPosition) => {
    keys.push(node.id);
    const position = { x: offset.x + (node.x ?? 0), y: offset.y + (node.y ?? 0) };
    const width = node.width ?? CARD_WIDTH;
    const parent = parentId === undefined ? {} : { parentId };
    if (node.children === undefined || node.children.length === 0) {
      nodes.push({
        id: node.id,
        type: "project",
        position,
        width,
        height: node.height ?? CARD_HEIGHT,
        zIndex: CARD_Z,
        style: CARD_STYLE,
        data: { key: node.id, header: false },
        ...parent,
      });
      return;
    }
    const boxId = `${GROUP_PREFIX}${node.id}`;
    nodes.push(
      {
        id: boxId,
        type: "projectBox",
        position,
        width,
        height: node.height ?? CARD_HEIGHT,
        zIndex: BOX_Z,
        // The box itself is not a target: a click or drag on it reaches the pane.
        style: { pointerEvents: "none" },
        data: { key: node.id },
        ...parent,
      },
      {
        id: node.id,
        type: "project",
        position: { x: 0, y: 0 },
        width,
        height: CARD_HEIGHT,
        zIndex: CARD_Z,
        style: CARD_STYLE,
        parentId: boxId,
        data: { key: node.id, header: true },
      },
    );
    for (const child of node.children) place(child, boxId, { x: 0, y: 0 });
  };
  const collectEdges = (node: ElkNode) => {
    for (const edge of node.edges ?? []) {
      const source = edge.sources[0];
      const target = edge.targets[0];
      if (source === undefined || target === undefined) continue;
      const points: Array<XYPosition> = [];
      for (const section of edge.sections ?? []) {
        for (const point of [section.startPoint, ...(section.bendPoints ?? []), section.endPoint]) {
          const last = points.at(-1);
          if (last === undefined || last.x !== point.x || last.y !== point.y) {
            points.push({ x: point.x, y: point.y });
          }
        }
      }
      if (points.length < 2) continue;
      edges.push({
        id: edge.id,
        type: "routed",
        source,
        target,
        zIndex: EDGE_Z,
        data: { points },
      });
    }
    for (const child of node.children ?? []) collectEdges(child);
  };
  // Component wrappers are not drawn, so their offset moves into their top-level projects.
  for (const component of laidOut.children ?? []) {
    const origin = { x: component.x ?? 0, y: component.y ?? 0 };
    for (const child of component.children ?? []) place(child, undefined, origin);
  }
  collectEdges(laidOut);
  return { nodes, edges, keys: keys.toSorted().join("\n") };
}

/** An orthogonal polyline with its corners rounded. */
export function roundedPath(points: ReadonlyArray<XYPosition>, radius = 8): string {
  const round = (value: number) => Math.round(value * 10) / 10;
  const at = (point: XYPosition) => `${round(point.x)},${round(point.y)}`;
  return points
    .map((corner, index) => {
      const previous = points[index - 1];
      const next = points[index + 1];
      if (previous === undefined) return `M${at(corner)}`;
      const inLength = Math.hypot(corner.x - previous.x, corner.y - previous.y);
      const outLength = next === undefined ? 0 : Math.hypot(next.x - corner.x, next.y - corner.y);
      const r = Math.min(radius, inLength / 2, outLength / 2);
      if (next === undefined || r <= 0) return `L${at(corner)}`;
      const before = {
        x: corner.x - ((corner.x - previous.x) / inLength) * r,
        y: corner.y - ((corner.y - previous.y) / inLength) * r,
      };
      const after = {
        x: corner.x + ((next.x - corner.x) / outLength) * r,
        y: corner.y + ((next.y - corner.y) / outLength) * r,
      };
      return `L${at(before)} Q${at(corner)} ${at(after)}`;
    })
    .join(" ");
}
