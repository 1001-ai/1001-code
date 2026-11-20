import { describe, expect, it } from "vite-plus/test";

import { moveProjectScopeKey, projectOrderForGroups } from "./projectScopeReorder.logic";

describe("moveProjectScopeKey", () => {
  const keys = ["pinned-a", "pinned-b", "c", "d", "e"];
  const pinnedKeys = new Set(["pinned-a", "pinned-b"]);

  it.each([
    ["down within unpinned", "c", "e", ["pinned-a", "pinned-b", "d", "e", "c"]],
    ["up within unpinned", "e", "c", ["pinned-a", "pinned-b", "e", "c", "d"]],
    ["within pinned", "pinned-b", "pinned-a", ["pinned-b", "pinned-a", "c", "d", "e"]],
    ["unpinned onto pinned", "c", "pinned-b", null],
    ["pinned onto unpinned", "pinned-a", "d", null],
    ["onto itself", "d", "d", null],
    ["onto a key the menu does not list", "d", "all", null],
  ])("%s", (_name, activeKey, overKey, expected) => {
    expect(moveProjectScopeKey({ keys, pinnedKeys, activeKey, overKey })).toEqual(expected);
  });
});

describe("projectOrderForGroups", () => {
  it("keeps a group's checkouts together and keeps unlisted saved keys after", () => {
    const group = (...keys: string[]) => ({
      memberProjects: keys.map((physicalProjectKey) => ({ physicalProjectKey })),
    });
    expect(
      projectOrderForGroups({
        groups: [group("b"), group("a-local", "a-remote"), group("c")],
        previousOrder: ["a-local", "archived", "b", "a-remote", "offline"],
      }),
    ).toEqual(["b", "a-local", "a-remote", "c", "archived", "offline"]);
  });
});
