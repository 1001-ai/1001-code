import { describe, expect, it } from "vite-plus/test";

import { layoutTeamProjectGraph, NODE_HEIGHT, NODE_WIDTH } from "./teamProjectGraphLayout";

const inside = (
  node: { readonly x: number; readonly y: number },
  box: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
) =>
  node.x >= box.x &&
  node.y >= box.y &&
  node.x + NODE_WIDTH <= box.x + box.width &&
  node.y + NODE_HEIGHT <= box.y + box.height;

describe("layoutTeamProjectGraph", () => {
  it("draws children and grandchildren inside their parent's box, below the parent", () => {
    const layout = layoutTeamProjectGraph(
      [
        { key: "suite" },
        { key: "api", parent: "suite" },
        { key: "web", parent: "suite" },
        { key: "worker", parent: "api" },
        { key: "cli" },
      ],
      2000,
    );
    const suite = layout.clusters.find((cluster) => cluster.key === "suite")!;
    const api = layout.clusters.find((cluster) => cluster.key === "api")!;
    expect(layout.clusters.map((cluster) => cluster.key)).toEqual(["suite", "api"]);
    for (const key of ["suite", "api", "web", "worker"]) {
      expect(inside(layout.nodes.get(key)!, suite), key).toBe(true);
    }
    expect(inside(layout.nodes.get("worker")!, api)).toBe(true);
    expect(inside(layout.nodes.get("cli")!, suite)).toBe(false);
    expect(layout.nodes.get("api")!.y).toBeGreaterThan(layout.nodes.get("suite")!.y);
    expect(layout.nodes.get("worker")!.y).toBeGreaterThan(layout.nodes.get("api")!.y);
  });

  it("draws a project with an unknown parent or a parent loop at the top level, once", () => {
    const layout = layoutTeamProjectGraph(
      [
        { key: "a", parent: "b" },
        { key: "b", parent: "a" },
        { key: "orphan", parent: "ghost" },
      ],
      2000,
    );
    expect([...layout.nodes.keys()].toSorted()).toEqual(["a", "b", "orphan"]);
    expect(layout.clusters).toEqual([]);
  });

  it("wraps top-level projects into rows that fit the width", () => {
    const projects = Array.from({ length: 6 }, (_, index) => ({ key: `p${index}` }));
    const layout = layoutTeamProjectGraph(projects, 3 * NODE_WIDTH + 200);
    const rows = new Set([...layout.nodes.values()].map((node) => node.y));
    expect(rows.size).toBe(2);
    expect(layout.width).toBeLessThanOrEqual(3 * NODE_WIDTH + 200);
  });
});
