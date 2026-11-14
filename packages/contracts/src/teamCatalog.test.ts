import { describe, expect, it } from "@effect/vitest";

import type { RepositoryIdentity } from "./environment.ts";
import {
  isTeamCatalogSource,
  matchTeamCatalogProjects,
  type TeamCatalogEntry,
} from "./teamCatalog.ts";

const entry = (key: string, repo: string): TeamCatalogEntry => ({
  file: `projects/${key}.json`,
  project: { key, name: key, repo, owners: [] },
  cloneUrl: `https://${repo}.git`,
  checkout: { path: `/projects/${key}`, state: "missing" },
});

const identity = (canonicalKey: string, originKey?: string): RepositoryIdentity => ({
  canonicalKey,
  locator: { source: "git-remote", remoteName: "origin", remoteUrl: `https://${canonicalKey}` },
  ...(originKey === undefined ? {} : { origin: { canonicalKey: originKey } }),
});

describe("matchTeamCatalogProjects", () => {
  it("matches by repository remote, never by path", () => {
    const projects = [
      {
        id: "web-checkout",
        workspaceRoot: "/projects/api",
        repositoryIdentity: identity("github.com/acme/web"),
      },
      { id: "no-remote", workspaceRoot: "/projects/web", repositoryIdentity: null },
      // A fork's canonical key is its upstream; its origin is the repository the catalog names.
      {
        id: "fork",
        workspaceRoot: "/elsewhere/tools",
        repositoryIdentity: identity("github.com/upstream/tools", "github.com/acme/tools"),
      },
      // Identities key a remote without its port, whichever transport it was cloned over.
      {
        id: "ported",
        workspaceRoot: "/projects/forge",
        repositoryIdentity: identity("git.example.com/team/forge"),
      },
    ];
    const matches = matchTeamCatalogProjects(
      [
        entry("web", "github.com/Acme/Web.git"),
        entry("api", "github.com/acme/api"),
        entry("tools", "github.com/acme/tools"),
        entry("forge", "git.example.com:2222/team/forge"),
        entry("other-port", "git.example.com:8443/team/other"),
      ],
      projects,
    );
    expect(
      matches.map((match) => [match.entry.project.key, match.localProject?.id ?? null]),
    ).toEqual([
      ["web", "web-checkout"],
      ["api", null],
      ["tools", "fork"],
      ["forge", "ported"],
      ["other-port", null],
    ]);
  });

  it("prefers a project that is not archived", () => {
    const [match] = matchTeamCatalogProjects(
      [entry("web", "github.com/acme/web")],
      [
        {
          id: "archived",
          archivedAt: "2026-01-01T00:00:00.000Z",
          repositoryIdentity: identity("github.com/acme/web"),
        },
        { id: "active", archivedAt: null, repositoryIdentity: identity("github.com/acme/web") },
      ],
    );
    expect(match?.localProject?.id).toBe("active");
  });
});

describe("isTeamCatalogSource", () => {
  it.each([
    ["https://github.com/acme/catalog.git", true],
    ["ssh://git@github.com/acme/catalog", true],
    ["git@github.com:acme/catalog.git", true],
    ["file:///srv/catalog", true],
    ["/srv/catalog", true],
    ["--upload-pack=touch /tmp/x", false],
    ["ext::sh -c touch% /tmp/x", false],
    ["fd::17", false],
    ["relative/catalog", false],
    ["https://github.com/acme/cat alog", false],
  ])("%s → %s", (source, expected) => {
    expect(isTeamCatalogSource(source)).toBe(expected);
  });
});
