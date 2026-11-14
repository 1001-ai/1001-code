import { describe, expect, it } from "@effect/vitest";

import type { TeamCatalogLink, TeamCatalogProject } from "./teamCatalog.ts";
import {
  checkTeamCatalogProposal,
  describeTeamCatalogIssue,
  describeTeamProjectChange,
  matchingWriteChanges,
  resolveTeamProjectGraph,
  type TeamCatalogProjectChange,
} from "./teamProjectLinks.ts";

const project = (
  key: string,
  options: {
    readonly parent?: string;
    readonly links?: ReadonlyArray<TeamCatalogLink>;
    readonly owners?: ReadonlyArray<string>;
  } = {},
): TeamCatalogProject => ({
  key,
  name: key,
  repo: `example.com/acme/${key}`,
  owners: options.owners ?? [],
  ...(options.parent === undefined ? {} : { parent: options.parent }),
  ...(options.links === undefined ? {} : { links: options.links }),
});

const read = (target: string): TeamCatalogLink => ({ project: target, access: "read" });
const write = (target: string): TeamCatalogLink => ({ project: target, access: "write" });

describe("resolveTeamProjectGraph", () => {
  it.each([
    {
      name: "a read link is active",
      projects: [project("web", { links: [read("api")] }), project("api")],
      links: [["web", "api", "read", "active"]],
      issues: [],
    },
    {
      name: "a write link declared on one side is pending",
      projects: [project("web", { links: [write("api")] }), project("api")],
      links: [["web", "api", "write", "pending"]],
      issues: [],
    },
    {
      name: "a write link answered by a read link is still pending",
      projects: [
        project("web", { links: [write("api")] }),
        project("api", { links: [read("web")] }),
      ],
      links: [
        ["web", "api", "write", "pending"],
        ["api", "web", "read", "active"],
      ],
      issues: [],
    },
    {
      name: "a write link both sides declare is active on both",
      projects: [
        project("web", { links: [write("api")] }),
        project("api", { links: [write("web")] }),
      ],
      links: [
        ["web", "api", "write", "active"],
        ["api", "web", "write", "active"],
      ],
      issues: [],
    },
    {
      name: "a read link to an unreachable repository has no access",
      projects: [
        project("web", { links: [read("vault"), read("api")] }),
        project("vault"),
        project("api"),
      ],
      links: [
        ["web", "vault", "read", "no-access"],
        ["web", "api", "read", "active"],
      ],
      issues: [],
    },
    {
      name: "an unknown link target is an issue, not a link",
      projects: [project("web", { links: [read("ghost")] })],
      links: [],
      issues: ['web links to "ghost", which is not in the catalog.'],
    },
    {
      name: "an unknown parent is an issue",
      projects: [project("web", { parent: "ghost" })],
      links: [],
      issues: ['web\'s parent "ghost" is not in the catalog.'],
    },
    {
      name: "a self link is an issue",
      projects: [project("web", { links: [write("web")] })],
      links: [],
      issues: ["web links to itself."],
    },
    {
      name: "a duplicate link keeps the first declaration",
      projects: [project("web", { links: [read("api"), write("api")] }), project("api")],
      links: [["web", "api", "read", "active"]],
      issues: ["web links to api more than once."],
    },
    {
      name: "a project that is its own parent is a cycle",
      projects: [project("web", { parent: "web" })],
      links: [],
      issues: ["web is its own parent."],
    },
    {
      name: "a parent loop is reported once",
      projects: [
        project("a", { parent: "c" }),
        project("b", { parent: "a" }),
        project("c", { parent: "b" }),
        project("leaf", { parent: "a" }),
      ],
      links: [],
      issues: ["Parents form a loop: a, b, c."],
    },
    {
      name: "a deep hierarchy without a loop is fine",
      projects: [
        project("suite"),
        project("api", { parent: "suite" }),
        project("worker", { parent: "api" }),
      ],
      links: [],
      issues: [],
    },
  ])("$name", ({ projects, links, issues }) => {
    const graph = resolveTeamProjectGraph(projects, (key) => (key === "vault" ? false : null));
    expect(graph.links.map((link) => [link.from, link.to, link.access, link.status])).toEqual(
      links,
    );
    expect(graph.issues.map(describeTeamCatalogIssue)).toEqual(issues);
  });
});

describe("matchingWriteChanges", () => {
  it.each([
    {
      name: "adds the write link back",
      projects: [project("web"), project("api", { links: [read("docs")] }), project("docs")],
      change: { key: "web", parent: null, links: [write("api")] },
      expected: [{ key: "api", parent: null, links: [read("docs"), write("web")] }],
    },
    {
      name: "turns a read link back into a write link",
      projects: [project("web"), project("api", { parent: "suite", links: [read("web")] })],
      change: { key: "web", parent: null, links: [write("api")] },
      expected: [{ key: "api", parent: "suite", links: [write("web")] }],
    },
    {
      name: "skips write links already declared back, read links and unknown projects",
      projects: [project("web"), project("api", { links: [write("web")] }), project("docs")],
      change: { key: "web", parent: null, links: [write("api"), read("docs"), write("ghost")] },
      expected: [],
    },
  ])("$name", ({ projects, change, expected }) => {
    expect(matchingWriteChanges(projects, change)).toEqual(expected);
  });
});

describe("checkTeamCatalogProposal", () => {
  const catalog = [
    project("suite", { owners: ["Lead"] }),
    project("web", { owners: ["alice"], parent: "suite", links: [read("api")] }),
    project("api", { owners: ["bob"], parent: "suite", links: [read("web")] }),
    project("docs", { owners: ["carol"] }),
  ];
  const change = (
    key: string,
    links: ReadonlyArray<TeamCatalogLink>,
    parent: string | null = "suite",
  ): TeamCatalogProjectChange => ({ key, parent, links });

  it.each([
    {
      name: "an owner adds a read link",
      login: "alice",
      changes: [change("web", [read("api"), read("docs")])],
      expected: null,
    },
    {
      name: "owners match case-insensitively",
      login: "lead",
      changes: [change("suite", [read("docs")], null)],
      expected: null,
    },
    {
      name: "a signed-out viewer cannot propose",
      login: null,
      changes: [change("web", [read("docs")])],
      expected: "Sign in to the GitHub CLI (gh auth login) to propose changes.",
    },
    {
      name: "a non-owner cannot change links",
      login: "bob",
      changes: [change("web", [])],
      expected: "Only the owners of web can change its parent and links.",
    },
    {
      name: "a non-owner cannot change the parent",
      login: "bob",
      changes: [change("web", [read("api")], null)],
      expected: "Only the owners of web can change its parent and links.",
    },
    {
      name: "an owner proposes the other side of a write link",
      login: "alice",
      changes: [change("web", [write("api")]), change("api", [write("web")])],
      expected: null,
    },
    {
      name: "the other side may only answer the write link",
      login: "alice",
      changes: [change("web", [write("api")]), change("api", [write("web"), read("docs")])],
      expected: "Only the owners of api can change its parent and links.",
    },
    {
      name: "the other side cannot be changed without the owned write link",
      login: "alice",
      changes: [change("web", [read("api")]), change("api", [write("web")])],
      expected: "Only the owners of api can change its parent and links.",
    },
    {
      name: "an unchanged proposal is refused",
      login: "alice",
      changes: [change("web", [read("api")])],
      expected: "Nothing changed.",
    },
    {
      name: "a project changed twice is refused",
      login: "alice",
      changes: [change("web", []), change("web", [read("docs")])],
      expected: "web is changed more than once.",
    },
    {
      name: "an unknown project is refused",
      login: "alice",
      changes: [change("ghost", [])],
      expected: '"ghost" is not in the catalog.',
    },
    {
      name: "a link to an unknown project is refused",
      login: "alice",
      changes: [change("web", [read("ghost")])],
      expected: 'web links to "ghost", which is not in the catalog.',
    },
    {
      name: "a self link is refused",
      login: "alice",
      changes: [change("web", [read("web")])],
      expected: "web links to itself.",
    },
    {
      name: "a duplicate link is refused",
      login: "alice",
      changes: [change("web", [read("api"), write("api")])],
      expected: "web links to api more than once.",
    },
    {
      name: "a parent loop is refused",
      login: "lead",
      changes: [change("suite", [], "web")],
      expected: "Parents form a loop: suite, web.",
    },
  ])("$name", ({ login, changes, expected }) => {
    expect(checkTeamCatalogProposal(catalog, changes, login)).toBe(expected);
  });

  it("does not blame a proposal for mistakes already in the catalog", () => {
    const broken = [...catalog, project("old", { owners: ["dave"], links: [read("gone")] })];
    expect(checkTeamCatalogProposal(broken, [change("web", [read("docs")])], "alice")).toBeNull();
  });
});

describe("describeTeamProjectChange", () => {
  it("lists parent and link changes", () => {
    expect(
      describeTeamProjectChange(
        project("web", { parent: "suite", links: [read("api"), read("docs")] }),
        {
          key: "web",
          parent: null,
          links: [write("api"), read("cli")],
        },
      ),
    ).toEqual(["no parent", "writes api", "reads cli", "unlinks docs"]);
  });
});
