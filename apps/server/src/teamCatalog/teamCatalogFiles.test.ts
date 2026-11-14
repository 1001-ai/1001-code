import { describe, expect, it } from "@effect/vitest";

import {
  decodeTeamCatalogFiles,
  teamCatalogCheckoutFolder,
  teamCatalogCloneUrl,
} from "./teamCatalogFiles.ts";

const file = (name: string, value: unknown) => ({
  file: `projects/${name}.json`,
  text: typeof value === "string" ? value : JSON.stringify(value),
});

const web = {
  key: "web",
  name: "Web",
  repo: "github.com/acme/web",
  owners: ["octocat"],
  parent: "suite",
  links: [
    { project: "api", access: "read" },
    { project: "docs", access: "write" },
  ],
};

describe("decodeTeamCatalogFiles", () => {
  it("keeps valid projects, including parent and links", () => {
    const decoded = decodeTeamCatalogFiles([
      file("web", web),
      file("api", { key: "api", name: "API", repo: "gitlab.example.com/acme/api", owners: [] }),
    ]);
    expect(decoded.invalid).toEqual([]);
    expect(decoded.projects.map((entry) => entry.file)).toEqual([
      "projects/api.json",
      "projects/web.json",
    ]);
    expect(decoded.projects[1]?.project).toEqual(web);
  });

  it.each([
    ["not JSON", "{", /./],
    ["an unknown field", { ...web, title: "Web" }, /title/],
    ["a missing field", { key: "web", name: "Web", repo: "github.com/acme/web" }, /owners/],
    ["a scheme in repo", { ...web, repo: "https://github.com/acme/web" }, /repo/],
    ["a repo without an owner", { ...web, repo: "github.com/web" }, /repo/],
    ["a repo leaving its folder", { ...web, repo: "github.com/acme/.." }, /repo/],
    ["an unknown access", { ...web, links: [{ project: "api", access: "admin" }] }, /access/],
    ["an invalid owner", { ...web, owners: ["not a login"] }, /owners/],
    ["a key unlike the file", { ...web, key: "site" }, /file name/],
    ["itself as parent", { ...web, parent: "web" }, /own parent/],
    ["a link to itself", { ...web, links: [{ project: "web", access: "read" }] }, /itself/],
    [
      "a project linked twice",
      {
        ...web,
        links: [
          { project: "api", access: "read" },
          { project: "api", access: "write" },
        ],
      },
      /more than once/,
    ],
  ])("skips a file with %s and says why", (_label, value, reason) => {
    const decoded = decodeTeamCatalogFiles([
      file("web", value),
      file("ok", { ...web, key: "ok", parent: undefined, repo: "github.com/acme/ok" }),
    ]);
    expect(decoded.projects.map((entry) => entry.project.key)).toEqual(["ok"]);
    expect(decoded.invalid).toHaveLength(1);
    expect(decoded.invalid[0]?.file).toBe("projects/web.json");
    expect(decoded.invalid[0]?.reason).toMatch(reason);
  });

  it("keeps the first file, by name, that lists a repository", () => {
    const decoded = decodeTeamCatalogFiles([
      file("web", web),
      file("site", { ...web, key: "site", repo: "GitHub.com/Acme/Web.git" }),
    ]);
    expect(decoded.projects.map((entry) => entry.project.key)).toEqual(["site"]);
    expect(decoded.invalid).toEqual([
      {
        file: "projects/web.json",
        reason: "projects/site.json already lists github.com/acme/web.",
      },
    ]);
  });
});

describe("teamCatalogCloneUrl", () => {
  it("clones over the transport the catalog was fetched with", () => {
    expect(teamCatalogCloneUrl("github.com/Acme/Web", "git@github.com:acme/catalog.git")).toBe(
      "git@github.com:Acme/Web.git",
    );
    expect(teamCatalogCloneUrl("github.com/Acme/Web", "ssh://git@github.com/acme/catalog")).toBe(
      "git@github.com:Acme/Web.git",
    );
    expect(teamCatalogCloneUrl("github.com/Acme/Web", "https://github.com/acme/catalog")).toBe(
      "https://github.com/Acme/Web.git",
    );
    expect(teamCatalogCloneUrl("github.com/acme/web.git", "/srv/catalog")).toBe(
      "https://github.com/acme/web.git",
    );
  });
});

describe("teamCatalogCheckoutFolder", () => {
  it("uses the repository name, or host folders like ghq", () => {
    expect(teamCatalogCheckoutFolder("github.com/Acme/Web", false)).toEqual(["Web"]);
    expect(teamCatalogCheckoutFolder("git.example.com:8443/acme/web.git", true)).toEqual([
      "git.example.com_8443",
      "acme",
      "web",
    ]);
  });
});
