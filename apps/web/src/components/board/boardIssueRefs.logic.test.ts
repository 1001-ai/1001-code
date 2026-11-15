import type { BoardColumn, BoardIssue, TeamCatalogEntry } from "@t3tools/contracts";
import { fromMarkdown } from "mdast-util-from-markdown";
import { describe, expect, it } from "vite-plus/test";

import {
  boardIssueOpenTarget,
  boardLinearIssueUrl,
  boardOpenIssueView,
  boardTeamKey,
  findBoardIssue,
  findIssueRefs,
  parseLinearIssueUrl,
  remarkBoardIssueRefs,
} from "./boardIssueRefs.logic";

const issue = (id: string, identifier: string): BoardIssue => ({
  id,
  identifier,
  title: identifier,
  url: `https://linear.app/acme/issue/${identifier}/some-title`,
  stateId: "todo",
  assignee: null,
  labels: [],
  priority: 0,
  createdAt: "2026-11-13T10:00:00.000Z",
  startedAt: null,
  updatedAt: "2026-11-14T10:00:00.000Z",
  pullRequests: [],
  threads: [],
});

const columns: ReadonlyArray<BoardColumn> = [
  {
    state: { id: "todo", name: "Todo", type: "unstarted", color: "#000" },
    issues: [issue("a", "COD-1")],
  },
  {
    state: { id: "doing", name: "In Progress", type: "started", color: "#fff" },
    issues: [issue("b", "COD-60")],
  },
];

describe("findIssueRefs", () => {
  it.each([
    ["prose and punctuation", "See COD-60, (ENG-7) and COD-61.", ["COD-60", "ENG-7", "COD-61"]],
    ["suffixes, paths and zero", "COD-60a COD-60-x a/COD-60 x-COD-60 COD-0 cod-60", []],
    ["multi-character keys", "T3_CODE-12 and A1-2", ["T3_CODE-12", "A1-2"]],
  ])("finds ids in %s", (_name, text, ids) => {
    expect(findIssueRefs(text).map((ref) => ref.identifier)).toEqual(ids);
  });
});

describe("parseLinearIssueUrl", () => {
  it.each([
    ["https://linear.app/acme/issue/COD-60/ship-it", "COD-60"],
    ["https://linear.app/acme/issue/cod-60", "COD-60"],
    ["https://linear.app/acme/issue/COD-60#comment-1", "COD-60"],
    ["https://linear.app/acme/project/COD-60", null],
    ["https://example.com/acme/issue/COD-60", null],
    ["http://linear.app/acme/issue/COD-60", null],
    ["not a url", null],
  ])("reads %s", (href, identifier) => {
    expect(parseLinearIssueUrl(href)).toBe(identifier);
  });
});

describe("boardTeamKey", () => {
  const entry = (repo: string, team?: string): TeamCatalogEntry => ({
    file: "projects/x.json",
    project: {
      key: "x",
      name: "X",
      repo,
      owners: [],
      ...(team === undefined ? {} : { linear: { team } }),
    },
    cloneUrl: `https://${repo}.git`,
    checkout: { path: "/tmp/x", state: "present" },
    reachable: true,
  });
  const identity = {
    canonicalKey: "github.com/acme/code",
    locator: { source: "git-remote" as const, remoteName: "origin", remoteUrl: "x" },
  };
  const catalogProjects = [
    entry("github.com/acme/other", "ENG"),
    entry("github.com/acme/code", "COD"),
  ];

  it("is the catalog team of the project's repository", () => {
    expect(boardTeamKey({ catalogProjects, repositoryIdentity: identity })).toBe("COD");
  });

  it.each([
    ["not in the catalog", [entry("github.com/acme/other", "ENG")]],
    ["without a Linear team", [entry("github.com/acme/code")]],
  ])("is null when the project is %s", (_name, projects) => {
    expect(boardTeamKey({ catalogProjects: projects, repositoryIdentity: identity })).toBeNull();
    expect(boardTeamKey({ catalogProjects, repositoryIdentity: null })).toBeNull();
  });
});

describe("boardIssueOpenTarget", () => {
  const target = (href: string, boardTeamKey: string | null = "COD", modified = false) =>
    boardIssueOpenTarget({ href, boardTeamKey, modified });

  it("opens Linear links of the board's team in the Board", () => {
    expect(target("https://linear.app/acme/issue/COD-60/ship-it")).toEqual({
      identifier: "COD-60",
      linearUrl: "https://linear.app/acme/issue/COD-60/ship-it",
    });
  });

  it.each([
    ["another team", "https://linear.app/acme/issue/ENG-60", "COD", false],
    ["no board", "https://linear.app/acme/issue/COD-60", null, false],
    ["a modified click", "https://linear.app/acme/issue/COD-60", "COD", true],
    ["another link", "https://github.com/acme/code/pull/1", "COD", false],
    ["an id written without a link", "t3-context://v1/linear-issue/COD-60", "COD", false],
  ])("leaves %s to Linear", (_name, href, teamKey, modified) => {
    expect(target(href, teamKey, modified)).toBeNull();
  });
});

describe("board lookups", () => {
  it("finds an issue by id or identifier, with its state", () => {
    expect(findBoardIssue(columns, "b")?.state.id).toBe("doing");
    expect(findBoardIssue(columns, "COD-60")?.issue.id).toBe("b");
    expect(findBoardIssue(columns, "COD-99")).toBeNull();
  });

  it("builds a Linear URL from the board's workspace", () => {
    expect(boardLinearIssueUrl(columns, "COD-99")).toBe("https://linear.app/acme/issue/COD-99");
    expect(boardLinearIssueUrl([], "COD-99")).toBeNull();
  });
});

describe("boardOpenIssueView", () => {
  const fromChat = (issue: string, linearUrl: string | null) => ({
    issue,
    fromOutside: true,
    linearUrl,
  });

  it.each([
    {
      name: "a board issue opened from the board",
      board: columns,
      open: { issue: "b", fromOutside: false, linearUrl: null },
      shows: "COD-60",
      note: null,
    },
    {
      name: "a chat link to a board issue",
      board: columns,
      open: fromChat("COD-60", "https://linear.app/acme/issue/COD-60/x"),
      shows: "COD-60",
      note: null,
    },
    {
      name: "another workspace's issue with a board issue's id",
      board: columns,
      open: fromChat("COD-60", "https://linear.app/other/issue/COD-60/x"),
      shows: null,
      note: { identifier: "COD-60", linearUrl: "https://linear.app/other/issue/COD-60/x" },
    },
    {
      name: "a plain id the board does not show",
      board: columns,
      open: fromChat("COD-99", null),
      shows: null,
      note: { identifier: "COD-99", linearUrl: "https://linear.app/acme/issue/COD-99" },
    },
    {
      name: "a chat link while the board is not ready",
      board: null,
      open: fromChat("COD-60", "https://linear.app/acme/issue/COD-60/x"),
      shows: null,
      note: { identifier: "COD-60", linearUrl: "https://linear.app/acme/issue/COD-60/x" },
    },
    {
      name: "an issue opened from the board that left it",
      board: columns,
      open: { issue: "gone", fromOutside: false, linearUrl: null },
      shows: null,
      note: null,
    },
  ])("$name", ({ board, open, shows, note }) => {
    const view = boardOpenIssueView(board, open);
    expect(view.open?.issue.identifier ?? null).toBe(shows);
    expect(view.note).toEqual(note);
  });
});

describe("remarkBoardIssueRefs", () => {
  const linkedIds = (markdown: string) => {
    const tree = fromMarkdown(markdown);
    remarkBoardIssueRefs()(tree);
    const ids: string[] = [];
    const visit = (node: { type: string; url?: string; children?: unknown[] }) => {
      if (node.type === "link" && node.url?.startsWith("t3-context://v1/linear-issue/")) {
        ids.push(node.url.slice("t3-context://v1/linear-issue/".length));
      }
      for (const child of node.children ?? []) visit(child as typeof node);
    };
    visit(tree);
    return ids;
  };

  it.each([
    [
      "prose, lists and emphasis",
      "Done in COD-60.\n\n- ENG-1 and *COD-2*",
      ["COD-60", "ENG-1", "COD-2"],
    ],
    ["code", "`COD-60` and\n\n```\nCOD-61\n```", []],
    ["existing links", "[COD-60](https://linear.app/acme/issue/COD-60)", []],
  ])("links ids in %s", (_name, markdown, ids) => {
    expect(linkedIds(markdown)).toEqual(ids);
  });
});
