import { describe, expect, it } from "vite-plus/test";

import {
  isPullRequestChipText,
  pullRequestChipLabel,
  pullRequestChipState,
} from "./pullRequestLinkChip.logic";

describe("isPullRequestChipText", () => {
  it.each([
    ["#115", true],
    [" #115 ", true],
    ["t3code#115", true],
    ["acme/t3code#115", true],
    ["#116", false],
    ["#0115", false],
    ["PR #115", false],
    ["see #115", false],
    ["https://github.com/acme/t3code/pull/115", false],
    ["a/b/c#115", false],
  ])("%j is a chip: %s", (text, expected) => {
    expect(isPullRequestChipText(text, 115)).toBe(expected);
  });

  it("is not a chip without text", () => {
    expect(isPullRequestChipText(null, 115)).toBe(false);
  });
});

describe("pullRequestChipState", () => {
  it("reads draft from an open pull request and is null while unknown", () => {
    expect(pullRequestChipState({ state: "open", isDraft: true })).toBe("draft");
    expect(pullRequestChipState({ state: "open", isDraft: false })).toBe("open");
    expect(pullRequestChipState({ state: "merged", isDraft: false })).toBe("merged");
    expect(pullRequestChipState({ state: "closed", isDraft: true })).toBe("closed");
    expect(pullRequestChipState(null)).toBeNull();
  });
});

describe("pullRequestChipLabel", () => {
  it.each([
    ["acme/t3code", "acme/t3code", "#115"],
    ["Acme/T3code", "acme/t3code", "#115"],
    ["acme/widgets", "acme/t3code", "widgets#115"],
    ["other/t3code", "acme/t3code", "other/t3code#115"],
    ["acme/widgets", null, "widgets#115"],
  ])("%s in a thread on %s reads %s", (repository, threadRepository, expected) => {
    expect(pullRequestChipLabel({ repository, number: 115, threadRepository })).toBe(expected);
  });
});
