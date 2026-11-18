import { describe, expect, it } from "vite-plus/test";

import { inboxFolderRowVisible, inboxSidebarProjects } from "./inboxSidebar.logic";

describe("inboxSidebarProjects", () => {
  it("lists the picked projects, or every pickable project when none is picked", () => {
    expect(inboxSidebarProjects(["acme"], ["acme", "globex"])).toEqual(["acme"]);
    expect(inboxSidebarProjects([], ["acme", "globex"])).toEqual(["acme", "globex"]);
  });
});

describe("inboxFolderRowVisible", () => {
  it("hides the row in a closed folder unless the Inbox is the open thread", () => {
    expect(inboxFolderRowVisible({ collapsed: false, isRoute: false })).toBe(true);
    expect(inboxFolderRowVisible({ collapsed: true, isRoute: false })).toBe(false);
    expect(inboxFolderRowVisible({ collapsed: true, isRoute: true })).toBe(true);
  });
});
