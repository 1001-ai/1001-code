import { expect, it } from "@effect/vitest";

import { stableCommitOf, stablePullRequestsOf, stableRepositoryWebUrl } from "./stableTag.ts";

const TAG = "481ef0835ecc3349fc6b9f7a72924739a9391d64";
const COMMIT = "1e161211f7b27f3498eda4948fdc041edc7b271b";

it("reads the commit an annotated or lightweight stable tag names", () => {
  expect(stableCommitOf(`${TAG}\trefs/tags/stable\n${COMMIT}\trefs/tags/stable^{}\n`)).toBe(COMMIT);
  expect(stableCommitOf(`${COMMIT}\trefs/tags/stable\n`)).toBe(COMMIT);
  expect(stableCommitOf(`${COMMIT}\trefs/tags/stable-old\n`)).toBeNull();
  expect(stableCommitOf("")).toBeNull();
});

it("lists the squash-merged pull requests of a range, oldest first, once each", () => {
  const subjects = [
    "feat: the Inbox starts a thread with a brief when you ask (#106)",
    "Merge upstream through 295a0a7332",
    "feat(fork): agents are told they run in the app (#104)",
    "fix!: Inboxes made by older builds can message threads (#107)",
    "mention #12 in the middle",
  ].join("\n");
  expect(stablePullRequestsOf(subjects)).toEqual([
    { number: 104, title: "agents are told they run in the app" },
    { number: 106, title: "the Inbox starts a thread with a brief when you ask" },
    { number: 107, title: "Inboxes made by older builds can message threads" },
  ]);
});

it("links pull requests only for a GitHub repository, keeping its name's case", () => {
  const github = (provider: string, displayName?: string) =>
    stableRepositoryWebUrl({
      canonicalKey: "github.com/acme/app",
      provider: provider as never,
      ...(displayName === undefined ? {} : { displayName }),
    });
  expect(github("github", "Acme/App")).toBe("https://github.com/Acme/App");
  expect(github("github")).toBe("https://github.com/acme/app");
  expect(github("gitlab", "acme/app")).toBeNull();
  expect(stableRepositoryWebUrl(null)).toBeNull();
});
