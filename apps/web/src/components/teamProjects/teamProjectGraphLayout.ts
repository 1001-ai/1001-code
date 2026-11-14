export const NODE_WIDTH = 168;
export const NODE_HEIGHT = 48;
const COLUMN_GAP = 24;
const ROW_GAP = 40;
const CLUSTER_PADDING = 16;
const CLUSTER_LABEL = 20;
const CLUSTER_GAP = 40;
const MARGIN = 24;

export interface GraphProjectInput {
  readonly key: string;
  readonly parent?: string | undefined;
}

export interface GraphNode {
  readonly key: string;
  readonly x: number;
  readonly y: number;
}

/** The box around a project that has children, drawn behind it and its descendants. */
export interface GraphCluster {
  readonly key: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface GraphLayout {
  readonly nodes: ReadonlyMap<string, GraphNode>;
  readonly clusters: ReadonlyArray<GraphCluster>;
  readonly width: number;
  readonly height: number;
}

interface PlacedTree {
  readonly width: number;
  readonly height: number;
  readonly nodes: ReadonlyArray<GraphNode>;
  readonly clusters: ReadonlyArray<GraphCluster>;
}

/**
 * Lays out projects as their parent hierarchy: a parent sits at the top of a box that holds its
 * children, recursively, and the top-level boxes wrap into rows `maxWidth` wide. A parent that
 * is unknown or part of a loop makes the project top-level, so every project is drawn once.
 */
export function layoutTeamProjectGraph(
  projects: ReadonlyArray<GraphProjectInput>,
  maxWidth: number,
): GraphLayout {
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
  const effectiveParent = (project: GraphProjectInput) =>
    project.parent !== undefined && keys.has(project.parent) && reachesRoot(project.key)
      ? project.parent
      : undefined;
  const children = new Map<string, Array<string>>();
  const roots: Array<string> = [];
  for (const project of projects) {
    const parent = effectiveParent(project);
    if (parent === undefined) roots.push(project.key);
    else children.set(parent, [...(children.get(parent) ?? []), project.key]);
  }

  const place = (key: string): PlacedTree => {
    const kids = children.get(key) ?? [];
    if (kids.length === 0) {
      return { width: NODE_WIDTH, height: NODE_HEIGHT, nodes: [{ key, x: 0, y: 0 }], clusters: [] };
    }
    const placed = kids.map(place);
    const rowWidth =
      placed.reduce((sum, tree) => sum + tree.width, 0) + COLUMN_GAP * (placed.length - 1);
    const innerWidth = Math.max(NODE_WIDTH, rowWidth);
    const width = innerWidth + CLUSTER_PADDING * 2;
    const childTop = CLUSTER_LABEL + NODE_HEIGHT + ROW_GAP;
    const nodes: Array<GraphNode> = [
      { key, x: CLUSTER_PADDING + (innerWidth - NODE_WIDTH) / 2, y: CLUSTER_LABEL },
    ];
    const clusters: Array<GraphCluster> = [];
    let x = CLUSTER_PADDING + (innerWidth - rowWidth) / 2;
    let rowHeight = 0;
    for (const tree of placed) {
      for (const node of tree.nodes) nodes.push({ ...node, x: node.x + x, y: node.y + childTop });
      for (const cluster of tree.clusters) {
        clusters.push({ ...cluster, x: cluster.x + x, y: cluster.y + childTop });
      }
      x += tree.width + COLUMN_GAP;
      rowHeight = Math.max(rowHeight, tree.height);
    }
    const height = childTop + rowHeight + CLUSTER_PADDING;
    return { width, height, nodes, clusters: [{ key, x: 0, y: 0, width, height }, ...clusters] };
  };

  // Groups first, then the standalone projects, each in catalog order.
  const trees = roots
    .map(place)
    .toSorted(
      (left, right) => Number(left.clusters.length === 0) - Number(right.clusters.length === 0),
    );
  const nodes = new Map<string, GraphNode>();
  const clusters: Array<GraphCluster> = [];
  const rowLimit = Math.max(maxWidth - MARGIN * 2, NODE_WIDTH);
  let x = 0;
  let y = 0;
  let rowHeight = 0;
  let width = 0;
  for (const tree of trees) {
    if (x > 0 && x + tree.width > rowLimit) {
      x = 0;
      y += rowHeight + CLUSTER_GAP;
      rowHeight = 0;
    }
    for (const node of tree.nodes) {
      nodes.set(node.key, { key: node.key, x: node.x + x + MARGIN, y: node.y + y + MARGIN });
    }
    for (const cluster of tree.clusters) {
      clusters.push({ ...cluster, x: cluster.x + x + MARGIN, y: cluster.y + y + MARGIN });
    }
    x += tree.width + CLUSTER_GAP;
    width = Math.max(width, x - CLUSTER_GAP);
    rowHeight = Math.max(rowHeight, tree.height);
  }
  return { nodes, clusters, width: width + MARGIN * 2, height: y + rowHeight + MARGIN * 2 };
}

/** Where the segment from `from`'s center toward `to`'s center leaves `from`'s box. */
function boxExit(from: GraphNode, to: GraphNode): { readonly x: number; readonly y: number } {
  const cx = from.x + NODE_WIDTH / 2;
  const cy = from.y + NODE_HEIGHT / 2;
  const dx = to.x + NODE_WIDTH / 2 - cx;
  const dy = to.y + NODE_HEIGHT / 2 - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };
  const scale = Math.min(
    dx === 0 ? Number.POSITIVE_INFINITY : NODE_WIDTH / 2 / Math.abs(dx),
    dy === 0 ? Number.POSITIVE_INFINITY : NODE_HEIGHT / 2 / Math.abs(dy),
  );
  return { x: cx + dx * scale, y: cy + dy * scale };
}

/**
 * A bent path between two boxes. It always bends to the left of its direction, so the two
 * directions between one pair of projects take opposite sides.
 */
export function edgePath(from: GraphNode, to: GraphNode): string {
  const start = boxExit(from, to);
  const end = boxExit(to, from);
  const mx = (start.x + end.x) / 2;
  const my = (start.y + end.y) / 2;
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const length = Math.hypot(dx, dy) || 1;
  // Along a row, boxes sit between the ends, so arc over them; elsewhere a slight bend will do.
  const offset =
    Math.abs(dx) > Math.abs(dy) * 3 ? Math.min(160, length * 0.35) : Math.min(40, length * 0.15);
  const qx = mx - (dy / length) * offset;
  const qy = my + (dx / length) * offset;
  const round = (value: number) => Math.round(value * 10) / 10;
  return `M${round(start.x)},${round(start.y)} Q${round(qx)},${round(qy)} ${round(end.x)},${round(end.y)}`;
}
