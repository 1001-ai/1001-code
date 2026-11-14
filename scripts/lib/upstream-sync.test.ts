// @effect-diagnostics nodeBuiltinImport:off - builds throwaway git repositories to drive the sync for real.
import { describe, expect, it } from "vite-plus/test";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  abort,
  finish,
  firstConflictIndex,
  merge,
  POINTER_PATH,
  readState,
  status,
  SyncError,
  type TargetOptions,
} from "./upstream-sync.ts";
import type { CiResult } from "./upstream-quarantine.ts";

function git(cwd: string, ...args: ReadonlyArray<string>) {
  return NodeChildProcess.execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: "pipe",
  }).trim();
}

const DAY = 24 * 60 * 60;
// Commit dates and quarantine both read this clock, so no test depends on when it runs.
const NOW = 1_790_000_000;

function commit(cwd: string, files: Record<string, string>, message: string, committedAt = NOW) {
  for (const [path, content] of Object.entries(files)) {
    NodeFS.mkdirSync(NodePath.dirname(NodePath.join(cwd, path)), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(cwd, path), content, { mode: 0o755 });
  }
  git(cwd, "add", "-A");
  NodeChildProcess.execFileSync("git", ["commit", "-q", "-m", message], {
    cwd,
    stdio: "pipe",
    env: { ...process.env, GIT_COMMITTER_DATE: `@${committedAt} +0000` },
  });
  return git(cwd, "rev-parse", "HEAD");
}

/** Quarantine that lets everything through, for tests about merging rather than choosing. */
const unquarantined: TargetOptions = {
  minAgeDays: 0,
  ci: () => ({ passed: true, since: 0 }),
  now: NOW,
};

function configure(cwd: string) {
  git(cwd, "config", "user.name", "Sync Test");
  git(cwd, "config", "user.email", "sync@example.com");
  git(cwd, "config", "commit.gpgsign", "false");
}

const read = (cwd: string, path: string) => NodeFS.readFileSync(NodePath.join(cwd, path), "utf8");
const pointerCommit = (cwd: string) =>
  (JSON.parse(git(cwd, "show", `HEAD:${POINTER_PATH}`)) as { commit: string }).commit;

/** An upstream repository and a fork cloned from it that records its starting point and changes `forkFiles`. */
function repos(initial: Record<string, string>, forkFiles: Record<string, string>) {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "upstream-sync-"));
  const upstream = NodePath.join(root, "upstream");
  const fork = NodePath.join(root, "fork");
  NodeFS.mkdirSync(upstream);
  git(upstream, "init", "-q", "-b", "main");
  configure(upstream);
  const start = commit(upstream, initial, "initial");
  git(root, "clone", "-q", upstream, fork);
  configure(fork);
  const pointer = { repository: upstream, branch: "main", commit: start };
  commit(fork, { ...forkFiles, [POINTER_PATH]: `${JSON.stringify(pointer)}\n` }, "fork changes");
  git(fork, "checkout", "-q", "-b", "sync");
  return {
    upstream,
    fork,
    [Symbol.dispose]: () => NodeFS.rmSync(root, { recursive: true, force: true }),
  };
}

function conflictRepos() {
  const setup = repos(
    { "shared.txt": "one\ntwo\nthree\n" },
    { "shared.txt": "one\nfork two\nthree\n" },
  );
  commit(setup.upstream, { "other.txt": "c1\n" }, "c1: other file");
  const c2 = commit(
    setup.upstream,
    { "shared.txt": "one\nupstream two\nthree\n" },
    "c2: change two",
  );
  commit(setup.upstream, { "another.txt": "c3\n" }, "c3: another file");
  return { ...setup, c2 };
}

describe("firstConflictIndex", () => {
  it("finds the boundary in at most 11 probes", () => {
    for (const boundary of [0, 1, 500, 998, 999]) {
      let probes = 0;
      const index = firstConflictIndex(1000, (candidate) => {
        probes += 1;
        return candidate < boundary;
      });
      expect(index).toBe(boundary);
      expect(probes).toBeLessThanOrEqual(11);
    }
  });
});

describe("upstream sync", () => {
  it("merges a clean range into one merge commit and reports sensitive changes", () => {
    const shared = Array.from({ length: 10 }, (_, line) => `line ${line}\n`);
    using setup = repos(
      { "shared.txt": shared.join(""), "a.txt": "a\n", "package.json": "{}\n" },
      { "shared.txt": ["fork 0\n", ...shared.slice(1)].join(""), "fork.txt": "fork\n" },
    );
    const { fork, upstream } = setup;
    const forkBase = git(fork, "rev-parse", "HEAD");
    // Hooks run from the working tree, so a merged hook would run upstream's code.
    git(fork, "config", "core.hooksPath", "hooks");
    const hook = "#!/bin/sh\ntouch hooked\n";
    const near = commit(
      upstream,
      { "shared.txt": [...shared.slice(0, 9), "upstream 9\n"].join("") },
      "near the fork's change",
    );
    commit(
      upstream,
      {
        "b.txt": "b\n",
        "hooks/post-merge": hook,
        "hooks/post-commit": hook,
        ".github/workflows/ci.yml": "on: push\n",
        "package.json": `${JSON.stringify({ scripts: { postinstall: "node x.js" } })}\n`,
      },
      "add b",
    );
    const tip = commit(upstream, { "a.txt": "a2\n" }, "change a");

    const before = status(fork, unquarantined);
    expect(before).toMatchObject({ behind: 3, clean: true, target: tip });
    expect(before.firstConflict).toBeUndefined();
    expect(before.attention.map((entry) => [entry.commit.sha, entry.files])).toEqual([
      [near, ["shared.txt"]],
    ]);

    expect(merge(fork, unquarantined).kind).toBe("merged");
    const result = finish(fork);

    expect(NodeFS.existsSync(NodePath.join(fork, "hooked"))).toBe(false);
    expect(result.squashed).toBe(false);
    expect(git(fork, "rev-list", "--parents", "-n", "1", "HEAD").split(" ").slice(1)).toEqual([
      forkBase,
      tip,
    ]);
    expect(git(fork, "rev-parse", "HEAD^{tree}")).toBe(
      git(fork, "rev-parse", `${result.detailRef}^{tree}`),
    );
    expect(read(fork, "b.txt")).toBe("b\n");
    expect(read(fork, "a.txt")).toBe("a2\n");
    expect(read(fork, "fork.txt")).toBe("fork\n");
    expect(read(fork, "shared.txt")).toMatch(/^fork 0\n[\s\S]*upstream 9\n$/);
    expect(pointerCommit(fork)).toBe(tip);
    expect(git(fork, "status", "--porcelain")).toBe("");
    expect(status(fork, unquarantined).behind).toBe(0);

    expect(result.sensitive.map((group) => group.reason)).toEqual([
      "package.json scripts, bin and lifecycle hooks",
      "CI workflows and actions",
    ]);
    expect(result.report).toMatch(/^## Sensitive changes \(2\)\n/);
    expect(result.report).toContain("`package.json`: script `postinstall` added (lifecycle hook");
    expect(result.report).toContain("Create a merge commit");
  });

  it("stops at the one upstream commit that conflicts and reports the resolution", () => {
    using setup = conflictRepos();
    const { fork, c2 } = setup;

    expect(status(fork, unquarantined).firstConflict).toMatchObject({
      commit: { sha: c2 },
      files: ["shared.txt"],
      cleanBefore: 1,
    });

    const outcome = merge(fork, unquarantined);
    expect(outcome).toMatchObject({
      kind: "conflict",
      stop: { commit: { sha: c2, subject: "c2: change two" }, files: ["shared.txt"] },
    });
    const conflicted = read(fork, "shared.txt");
    expect(conflicted).toContain("fork two");
    expect(conflicted).toContain("upstream two");
    expect(conflicted).toMatch(/\|{7}[^\n]*\ntwo\n={7}\n/);
    expect(read(fork, "other.txt")).toBe("c1\n");
    expect(() => merge(fork)).toThrow(SyncError);

    NodeFS.writeFileSync(NodePath.join(fork, "shared.txt"), "one\nresolved two\nthree\n");
    git(fork, "add", "shared.txt");
    expect(merge(fork).kind).toBe("merged");

    const result = finish(fork);
    expect(result.title).toContain("(3 commits)");
    expect(result.body).toContain("c2: change two");
    expect(result.body).toContain("shared.txt");
    expect(result.report).toContain("resolved two");
    expect(result.report).toContain("No upstream change in this sync matches a sensitive rule.");
    expect(read(fork, "another.txt")).toBe("c3\n");
  });

  it.each([
    { landing: "a squash merge", squash: true },
    { landing: "a merge commit", squash: false },
  ])("merges cleanly again after a sync that landed as $landing", ({ squash }) => {
    using setup = repos({ "a.txt": "a\n", "b.txt": "b1\n" }, { "a.txt": "fork a\n" });
    const { fork, upstream } = setup;
    // The fork keeps its side of this conflict; replaying it from the stale base would stop again.
    commit(upstream, { "a.txt": "upstream a\n" }, "upstream a");
    const first = commit(upstream, { "b.txt": "b2\n" }, "b2");
    expect(merge(fork, unquarantined).kind).toBe("conflict");
    git(fork, "checkout", "--ours", "a.txt");
    git(fork, "add", "a.txt");
    expect(merge(fork).kind).toBe("merged");
    const synced = finish(fork, { squash });
    const containsUpstream = NodeChildProcess.spawnSync(
      "git",
      ["merge-base", "--is-ancestor", first, "HEAD"],
      { cwd: fork },
    );
    expect(containsUpstream.status === 0).toBe(!squash);
    git(fork, "checkout", "-q", "main");
    // GitHub lands a squash as one new commit and a merge commit with "Create a merge commit".
    if (squash) git(fork, "merge", "-q", "--ff-only", "sync");
    else git(fork, "merge", "-q", "--no-ff", "--no-edit", "sync");
    git(fork, "branch", "-q", "-D", "sync");
    expect(git(fork, "rev-parse", "HEAD^{tree}")).toBe(
      git(fork, "rev-parse", `${synced.commit}^{tree}`),
    );

    const tip = commit(upstream, { "b.txt": "b3\n" }, "b3");
    commit(fork, { "c.txt": "fork c\n" }, "unrelated fork work");
    git(fork, "checkout", "-q", "-b", "sync-2");
    git(fork, "fetch", "-q", upstream, "main");
    const naive = NodeChildProcess.spawnSync(
      "git",
      ["merge-tree", "--write-tree", "HEAD", "FETCH_HEAD"],
      { cwd: fork },
    );
    expect(naive.status).toBe(squash ? 1 : 0);
    expect(status(fork, unquarantined)).toMatchObject({ behind: 1, clean: true });

    const outcome = merge(fork, unquarantined);
    expect(outcome.kind).toBe("merged");
    expect(outcome.kind === "merged" && outcome.state.stops).toEqual([]);
    finish(fork, { squash });
    expect(read(fork, "b.txt")).toBe("b3\n");
    expect(read(fork, "a.txt")).toBe("fork a\n");
    expect(read(fork, "c.txt")).toBe("fork c\n");
    expect(pointerCommit(fork)).toBe(tip);
  });

  it("targets the newest upstream commit that is old enough and passed CI on the branch", () => {
    using setup = repos({ "a.txt": "a\n" }, {});
    const { fork, upstream } = setup;
    const old = commit(upstream, { "a.txt": "old\n" }, "old", NOW - 9 * DAY);
    const failed = commit(upstream, { "a.txt": "failed\n" }, "failed", NOW - 6 * DAY);
    // Backdated, but CI shows it reached the branch yesterday.
    const backdated = commit(upstream, { "a.txt": "backdated\n" }, "backdated", NOW - 5 * DAY);
    const fresh = commit(upstream, { "a.txt": "fresh\n" }, "fresh", NOW - DAY);
    const results = new Map<string, CiResult>([
      [old, { passed: true, since: NOW - 9 * DAY }],
      [failed, { passed: false, detail: '"Check" failure' }],
      [backdated, { passed: true, since: NOW - DAY }],
      [fresh, { passed: true, since: NOW - DAY }],
    ]);
    const looked: Array<string> = [];
    const ci = (sha: string) => {
      looked.push(sha);
      return results.get(sha)!;
    };

    const chosen = status(fork, { ci, now: NOW });
    expect(chosen).toMatchObject({ target: old, behind: 1 });
    expect(looked).toEqual([backdated, failed, old]);
    expect(chosen.selection).toContain("1 committed less than 3 days ago");
    expect(chosen.selection).toContain('"Check" failure');
    expect(chosen.selection).toContain("CI ran on the branch less than 3 days ago");

    expect(status(fork, { ci, now: NOW, minAgeDays: 10 })).toMatchObject({
      target: git(fork, "rev-parse", "HEAD~1"),
      behind: 0,
    });
    const waiting = merge(fork, { ci, now: NOW, minAgeDays: 10 });
    expect(waiting).toMatchObject({ kind: "up-to-date" });
    expect(waiting.kind === "up-to-date" && waiting.selection).toContain(
      "No new upstream commit passes quarantine",
    );

    expect(merge(fork, { ci, now: NOW }).kind).toBe("merged");
    expect(readState(fork)?.target).toBe(old);
  });

  it("refuses to choose a target when upstream CI cannot be read, unless --to names one", () => {
    using setup = repos({ "a.txt": "a\n" }, {});
    const { fork, upstream } = setup;
    const tip = commit(upstream, { "a.txt": "a2\n" }, "a2", NOW - 9 * DAY);
    const start = git(fork, "rev-parse", "HEAD");
    let lookups = 0;
    const ci = () => {
      lookups += 1;
      throw new Error("gh: not signed in");
    };

    expect(() => status(fork, { ci, now: NOW })).toThrow(
      /Could not read upstream CI.*not signed in/,
    );
    expect(() => merge(fork, { ci, now: NOW })).toThrow(SyncError);
    expect(readState(fork)).toBeUndefined();
    expect(git(fork, "rev-parse", "HEAD")).toBe(start);

    lookups = 0;
    expect(merge(fork, { ci, now: NOW, to: tip }).kind).toBe("merged");
    expect(lookups).toBe(0);
    expect(readState(fork)?.selection).toContain("--to");
  });

  it("refuses the default branch, a dirty tree and upstream changes to the sync tool, and abort restores the start", () => {
    using setup = conflictRepos();
    const { fork, upstream } = setup;
    const start = git(fork, "rev-parse", "HEAD");

    git(fork, "checkout", "-q", "main");
    expect(() => merge(fork, unquarantined)).toThrow(SyncError);
    git(fork, "checkout", "-q", "sync");

    NodeFS.writeFileSync(NodePath.join(fork, "dirty.txt"), "dirty\n");
    expect(() => merge(fork, unquarantined)).toThrow(SyncError);
    NodeFS.rmSync(NodePath.join(fork, "dirty.txt"));
    expect(readState(fork)).toBeUndefined();

    expect(merge(fork, unquarantined).kind).toBe("conflict");
    abort(fork);
    expect(git(fork, "rev-parse", "HEAD")).toBe(start);
    expect(git(fork, "status", "--porcelain")).toBe("");
    expect(readState(fork)).toBeUndefined();

    commit(upstream, { "scripts/lib/upstream-sync.ts": "export {};\n" }, "touch the tool");
    expect(() => merge(fork, unquarantined)).toThrow(/sync tool's own files/);
    expect(readState(fork)).toBeUndefined();
  });
});
