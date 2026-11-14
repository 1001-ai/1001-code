import type { TeamProjectLink } from "@t3tools/contracts";
import ElkConstructor from "elkjs/lib/elk.bundled.js";
import { describe, expect, it } from "vite-plus/test";

import {
  drawnTeamProjectLinks,
  type TeamProjectFlow,
  teamProjectElkGraph,
  teamProjectFlow,
} from "./teamProjectGraphElk";

const elk = new ElkConstructor();

const link = (
  from: string,
  to: string,
  access: TeamProjectLink["access"],
  status: TeamProjectLink["status"] = "active",
): TeamProjectLink => ({ from, to, access, status });

async function layOut(
  projects: ReadonlyArray<{ readonly key: string; readonly parent?: string }>,
  links: ReadonlyArray<TeamProjectLink>,
): Promise<TeamProjectFlow> {
  return teamProjectFlow(await elk.layout(teamProjectElkGraph(projects, links)));
}

interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

function absoluteRects(flow: TeamProjectFlow): ReadonlyMap<string, Rect> {
  const byId = new Map(flow.nodes.map((node) => [node.id, node]));
  const rects = new Map<string, Rect>();
  for (const node of flow.nodes) {
    const parent = node.parentId === undefined ? undefined : rects.get(node.parentId);
    // Parents come first, so a child's box is already placed.
    expect(node.parentId === undefined || parent !== undefined, node.id).toBe(true);
    rects.set(node.id, {
      x: (parent?.x ?? 0) + node.position.x,
      y: (parent?.y ?? 0) + node.position.y,
      width: byId.get(node.id)?.width ?? 0,
      height: byId.get(node.id)?.height ?? 0,
    });
  }
  return rects;
}

const contains = (outer: Rect, inner: Rect) =>
  inner.x >= outer.x &&
  inner.y >= outer.y &&
  inner.x + inner.width <= outer.x + outer.width &&
  inner.y + inner.height <= outer.y + outer.height;

const onBorder = (rect: Rect, point: { readonly x: number; readonly y: number }) => {
  const inside =
    point.x >= rect.x - 0.5 &&
    point.x <= rect.x + rect.width + 0.5 &&
    point.y >= rect.y - 0.5 &&
    point.y <= rect.y + rect.height + 0.5;
  const nearEdge =
    Math.abs(point.x - rect.x) < 0.5 ||
    Math.abs(point.x - rect.x - rect.width) < 0.5 ||
    Math.abs(point.y - rect.y) < 0.5 ||
    Math.abs(point.y - rect.y - rect.height) < 0.5;
  return inside && nearEdge;
};

describe("teamProjectGraph", () => {
  it("draws children and grandchildren inside their parent's box, under the parent's card", async () => {
    const flow = await layOut(
      [
        { key: "suite" },
        { key: "api", parent: "suite" },
        { key: "web", parent: "suite" },
        { key: "worker", parent: "api" },
        { key: "cli" },
      ],
      [],
    );
    const rects = absoluteRects(flow);
    const suite = rects.get("group:suite")!;
    const api = rects.get("group:api")!;
    expect(rects.has("group:cli")).toBe(false);
    for (const key of ["suite", "group:api", "api", "web", "worker"]) {
      expect(contains(suite, rects.get(key)!), key).toBe(true);
    }
    expect(contains(api, rects.get("worker")!)).toBe(true);
    expect(contains(suite, rects.get("cli")!)).toBe(false);
    expect(rects.get("suite")).toMatchObject({ x: suite.x, y: suite.y, width: suite.width });
    expect(rects.get("api")!.y).toBeGreaterThan(rects.get("suite")!.y);
    expect(rects.get("worker")!.y).toBeGreaterThan(rects.get("api")!.y);
  });

  it("draws a project with an unknown parent or a parent loop at the top level, once", () => {
    const graph = teamProjectElkGraph(
      [
        { key: "a", parent: "b" },
        { key: "b", parent: "a" },
        { key: "orphan", parent: "ghost" },
      ],
      [],
    );
    const topLevel = (graph.children ?? []).flatMap((component) => component.children ?? []);
    expect(topLevel.map((node) => node.id).toSorted()).toEqual(["a", "b", "orphan"]);
    expect(topLevel.every((node) => node.children === undefined)).toBe(true);
  });

  it("draws an agreed write link as one edge, and one-sided writes and reads each as their own", () => {
    const drawn = drawnTeamProjectLinks(
      [
        link("b", "a", "write"),
        link("a", "b", "write"),
        link("a", "c", "write", "pending"),
        link("c", "a", "read"),
        link("a", "c", "read", "no-access"),
        link("a", "ghost", "read"),
      ],
      new Set(["a", "b", "c"]),
    );
    expect(drawn.map(({ id, mutual }) => [id, mutual])).toEqual([
      ["a>b:write", true],
      ["a>c:write", false],
      ["c>a:read", false],
      ["a>c:read", false],
    ]);
  });

  it("lays out linked projects together and the unlinked ones after them", () => {
    const graph = teamProjectElkGraph(
      [{ key: "lone" }, { key: "api" }, { key: "suite" }, { key: "web", parent: "suite" }],
      [link("api", "web", "read")],
    );
    expect(
      (graph.children ?? []).map((component) => [
        (component.children ?? []).map((node) => node.id),
        (component.edges ?? []).map((edge) => edge.id),
      ]),
    ).toEqual([
      [["api", "suite"], ["api>web:read"]],
      [["lone"], []],
    ]);
  });

  it("routes edges in absolute coordinates while nested projects stay relative to their box", async () => {
    const flow = await layOut(
      [
        { key: "suite" },
        { key: "api", parent: "suite" },
        { key: "worker", parent: "api" },
        { key: "db", parent: "api" },
        { key: "cli" },
      ],
      [
        link("worker", "db", "read"),
        link("cli", "worker", "write", "pending"),
        link("suite", "db", "read"),
      ],
    );
    const rects = absoluteRects(flow);
    const worker = flow.nodes.find((node) => node.id === "worker")!;
    expect(worker.parentId).toBe("group:api");
    expect(contains(rects.get("group:api")!, rects.get("worker")!)).toBe(true);
    expect(flow.edges.map((edge) => edge.id).toSorted()).toEqual([
      "cli>worker:write",
      "suite>db:read",
      "worker>db:read",
    ]);
    for (const edge of flow.edges) {
      const points = edge.data!.points;
      const source = rects.get(`group:${edge.source}`) ?? rects.get(edge.source)!;
      const target = rects.get(`group:${edge.target}`) ?? rects.get(edge.target)!;
      expect(onBorder(source, points[0]!), `${edge.id} starts on ${edge.source}`).toBe(true);
      expect(onBorder(target, points.at(-1)!), `${edge.id} ends on ${edge.target}`).toBe(true);
    }
  });
});
