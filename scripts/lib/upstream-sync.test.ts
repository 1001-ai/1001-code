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
} from "./upstream-sync.ts";

function git(cwd: string, ...args: ReadonlyArray<string>) {
  return NodeChildProcess.execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: "pipe",
  }).trim();
}

function commit(cwd: string, files: Record<string, string>, message: string) {
  for (const [path, content] of Object.entries(files)) {
    NodeFS.mkdirSync(NodePath.dirname(NodePath.join(cwd, path)), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(cwd, path), content);
  }
  git(cwd, "add", "-A");
  git(cwd, "commit", "-q", "-m", message);
  return git(cwd, "rev-parse", "HEAD");
}

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
  it("merges a clean range and squashes it onto the fork commit", () => {
    const shared = Array.from({ length: 10 }, (_, line) => `line ${line}\n`);
    using setup = repos(
      { "shared.txt": shared.join(""), "a.txt": "a\n" },
      { "shared.txt": ["fork 0\n", ...shared.slice(1)].join(""), "fork.txt": "fork\n" },
    );
    const { fork, upstream } = setup;
    const forkBase = git(fork, "rev-parse", "HEAD");
    const near = commit(
      upstream,
      { "shared.txt": [...shared.slice(0, 9), "upstream 9\n"].join("") },
      "near the fork's change",
    );
    commit(upstream, { "b.txt": "b\n" }, "add b");
    const tip = commit(upstream, { "a.txt": "a2\n" }, "change a");

    const before = status(fork);
    expect(before).toMatchObject({ behind: 3, clean: true, target: tip });
    expect(before.firstConflict).toBeUndefined();
    expect(before.attention.map((entry) => [entry.commit.sha, entry.files])).toEqual([
      [near, ["shared.txt"]],
    ]);

    expect(merge(fork).kind).toBe("merged");
    finish(fork);

    expect(git(fork, "rev-list", "--parents", "-n", "1", "HEAD").split(" ").slice(1)).toEqual([
      forkBase,
    ]);
    expect(read(fork, "b.txt")).toBe("b\n");
    expect(read(fork, "a.txt")).toBe("a2\n");
    expect(read(fork, "fork.txt")).toBe("fork\n");
    expect(read(fork, "shared.txt")).toMatch(/^fork 0\n[\s\S]*upstream 9\n$/);
    expect(pointerCommit(fork)).toBe(tip);
    expect(git(fork, "status", "--porcelain")).toBe("");
    expect(status(fork).behind).toBe(0);
  });

  it("stops at the one upstream commit that conflicts and reports the resolution", () => {
    using setup = conflictRepos();
    const { fork, c2 } = setup;

    expect(status(fork).firstConflict).toMatchObject({
      commit: { sha: c2 },
      files: ["shared.txt"],
      cleanBefore: 1,
    });

    const outcome = merge(fork);
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
    expect(read(fork, "another.txt")).toBe("c3\n");
  });

  it("merges cleanly again after a squashed sync", () => {
    using setup = repos({ "a.txt": "a\n", "b.txt": "b1\n" }, { "a.txt": "fork a\n" });
    const { fork, upstream } = setup;
    // The fork keeps its side of this conflict; replaying it from the stale base would stop again.
    commit(upstream, { "a.txt": "upstream a\n" }, "upstream a");
    commit(upstream, { "b.txt": "b2\n" }, "b2");
    expect(merge(fork).kind).toBe("conflict");
    git(fork, "checkout", "--ours", "a.txt");
    git(fork, "add", "a.txt");
    expect(merge(fork).kind).toBe("merged");
    finish(fork);
    git(fork, "checkout", "-q", "main");
    git(fork, "merge", "-q", "--ff-only", "sync");
    git(fork, "branch", "-q", "-D", "sync");

    const tip = commit(upstream, { "b.txt": "b3\n" }, "b3");
    commit(fork, { "c.txt": "fork c\n" }, "unrelated fork work");
    git(fork, "checkout", "-q", "-b", "sync-2");
    git(fork, "fetch", "-q", upstream, "main");
    const naive = NodeChildProcess.spawnSync(
      "git",
      ["merge-tree", "--write-tree", "HEAD", "FETCH_HEAD"],
      { cwd: fork },
    );
    expect(naive.status).toBe(1);
    expect(status(fork)).toMatchObject({ behind: 1, clean: true });

    const outcome = merge(fork);
    expect(outcome.kind).toBe("merged");
    expect(outcome.kind === "merged" && outcome.state.stops).toEqual([]);
    finish(fork);
    expect(read(fork, "b.txt")).toBe("b3\n");
    expect(read(fork, "a.txt")).toBe("fork a\n");
    expect(read(fork, "c.txt")).toBe("fork c\n");
    expect(pointerCommit(fork)).toBe(tip);
  });

  it("refuses the default branch and a dirty tree, and abort restores the start", () => {
    using setup = conflictRepos();
    const { fork } = setup;
    const start = git(fork, "rev-parse", "HEAD");

    git(fork, "checkout", "-q", "main");
    expect(() => merge(fork)).toThrow(SyncError);
    git(fork, "checkout", "-q", "sync");

    NodeFS.writeFileSync(NodePath.join(fork, "dirty.txt"), "dirty\n");
    expect(() => merge(fork)).toThrow(SyncError);
    NodeFS.rmSync(NodePath.join(fork, "dirty.txt"));
    expect(readState(fork)).toBeUndefined();

    expect(merge(fork).kind).toBe("conflict");
    abort(fork);
    expect(git(fork, "rev-parse", "HEAD")).toBe(start);
    expect(git(fork, "status", "--porcelain")).toBe("");
    expect(readState(fork)).toBeUndefined();
  });
});
