import { describe, expect, it } from "@effect/vitest";

import { hostedRepositoryOf, proposalFileText } from "./teamCatalogProposal.ts";

describe("hostedRepositoryOf", () => {
  it.each([
    ["https://github.com/acme/catalog.git", "github.com/acme/catalog"],
    ["https://token@GitHub.com/acme/catalog", "github.com/acme/catalog"],
    ["git@github.com:acme/catalog.git", "github.com/acme/catalog"],
    ["ssh://git@git.example.com:2222/acme/catalog.git", "git.example.com/acme/catalog"],
    ["/srv/git/catalog.git", null],
    ["file:///srv/git/catalog.git", null],
  ])("%s", (source, expected) => {
    expect(hostedRepositoryOf(source)).toBe(expected);
  });
});

describe("proposalFileText", () => {
  it("replaces parent and links and keeps every other field in place", () => {
    const original = JSON.stringify({
      key: "web",
      parent: "suite",
      name: "Web",
      links: [{ project: "api", access: "read" }],
      owners: ["alice"],
    });
    expect(
      proposalFileText(original, {
        key: "web",
        parent: null,
        links: [{ project: "docs", access: "write" }],
      }),
    ).toBe(
      [
        "{",
        '  "key": "web",',
        '  "name": "Web",',
        '  "links": [',
        '    { "project": "docs", "access": "write" }',
        "  ],",
        '  "owners": ["alice"]',
        "}",
        "",
      ].join("\n"),
    );
    expect(proposalFileText(original, { key: "web", parent: "suite", links: [] })).not.toContain(
      "links",
    );
  });
});
