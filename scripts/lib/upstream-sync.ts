// @effect-diagnostics nodeBuiltinImport:off - drives git directly and runs without the Effect runtime.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

/** Records the upstream commit whose changes this fork already contains. */
export const POINTER_PATH = "fork/upstream.json";
const UPSTREAM_REF = "refs/sync-upstream/upstream";
const DETAIL_REF_PREFIX = "refs/sync-upstream/detail/";
const STATE_FILE = "sync-upstream.json";
const SYNC_SUBJECT_PREFIX = "sync: upstream through ";
const CONFLICT_MARKER = /^(<{7}|>{7}|\|{7}) /m;
const MINIMUM_GIT = [2, 40] as const;

// @effect-diagnostics-next-line extendsNativeError:off - plain synchronous Node with no Effect runtime.
export class SyncError extends Error {
  override readonly name = "SyncError";
}

export interface UpstreamPointer {
  readonly repository: string;
  readonly branch: string;
  readonly commit: string;
}

export interface UpstreamCommit {
  readonly sha: string;
  readonly subject: string;
  readonly pullRequest?: string;
}

/** An upstream commit that could not be merged without a decision, and the files it collided in. */
export interface SyncStop {
  readonly commit: UpstreamCommit;
  readonly files: ReadonlyArray<string>;
}

export interface SyncState {
  readonly branch: string;
  /** The fork commit the sync started from. */
  readonly forkBase: string;
  /** The upstream commit the fork contained when the sync started. */
  readonly base: string;
  readonly target: string;
  readonly stops: ReadonlyArray<SyncStop>;
}

export interface SyncStatus {
  readonly pointer: UpstreamPointer;
  readonly head: string;
  readonly base: string;
  readonly target: string;
  readonly behind: number;
  readonly clean: boolean;
  readonly firstConflict?: SyncStop & { readonly cleanBefore: number };
  /** Upstream commits that touch files the fork has changed, whether or not they conflict. */
  readonly attention: ReadonlyArray<SyncStop>;
  readonly inProgress?: SyncState;
}

export type MergeOutcome =
  | { readonly kind: "up-to-date"; readonly pointer: UpstreamPointer }
  | { readonly kind: "merged"; readonly state: SyncState }
  | { readonly kind: "conflict"; readonly state: SyncState; readonly stop: SyncStop };

export interface FinishResult {
  readonly commit: string;
  readonly title: string;
  readonly body: string;
  /** Local ref that keeps the step-by-step merges for review after squashing. */
  readonly detailRef: string;
  readonly squashed: boolean;
  /** Markdown for the pull request: what was merged, each resolution, and what to look at. */
  readonly report: string;
}

interface GitResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

function run(cwd: string, args: ReadonlyArray<string>, input?: string): GitResult {
  const result = NodeChildProcess.spawnSync("git", ["-c", "core.quotePath=false", ...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 1024,
    ...(input === undefined ? {} : { input }),
  });
  if (result.error) {
    throw new SyncError(`Could not run git ${args[0] ?? ""}: ${result.error.message}`);
  }
  return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
}

function git(cwd: string, args: ReadonlyArray<string>, input?: string): string {
  const result = run(cwd, args, input);
  if (result.status !== 0) {
    throw new SyncError(
      `git ${args.join(" ")} failed (${result.status}): ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
  return result.stdout.trim();
}

const lines = (text: string) => text.split("\n").filter((line) => line !== "");
const short = (sha: string) => sha.slice(0, 10);

function requireGit(cwd: string) {
  const version = /(\d+)\.(\d+)/.exec(git(cwd, ["version"]));
  const [major, minor] = [Number(version?.[1]), Number(version?.[2])];
  if (!(major > MINIMUM_GIT[0] || (major === MINIMUM_GIT[0] && minor >= MINIMUM_GIT[1]))) {
    throw new SyncError(`Syncing needs git ${MINIMUM_GIT.join(".")} or newer.`);
  }
}

function isAncestor(cwd: string, ancestor: string, descendant: string): boolean {
  const result = run(cwd, ["merge-base", "--is-ancestor", ancestor, descendant]);
  if (result.status > 1) {
    throw new SyncError(
      `Could not compare ${short(ancestor)} with ${short(descendant)}: ${result.stderr.trim()}`,
    );
  }
  return result.status === 0;
}

const mergeInProgress = (cwd: string) =>
  run(cwd, ["rev-parse", "--quiet", "--verify", "MERGE_HEAD"]).status === 0;

function requireCleanTree(cwd: string) {
  const dirty = lines(git(cwd, ["status", "--porcelain"]));
  if (dirty.length > 0) {
    throw new SyncError(
      `The working tree has changes. Syncing needs a clean checkout:\n${dirty.slice(0, 10).join("\n")}`,
    );
  }
}

export function readPointer(cwd: string, rev = "HEAD"): UpstreamPointer {
  const shown = run(cwd, ["show", `${rev}:${POINTER_PATH}`]);
  if (shown.status !== 0) {
    throw new SyncError(
      `${POINTER_PATH} is missing at ${rev}. It records the upstream commit this fork contains.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(shown.stdout);
  } catch {
    throw new SyncError(`${POINTER_PATH} at ${rev} is not valid JSON.`);
  }
  const { repository, branch, commit } = (parsed ?? {}) as Record<string, unknown>;
  if (
    typeof repository !== "string" ||
    typeof branch !== "string" ||
    typeof commit !== "string" ||
    !/^[0-9a-f]{40}$/.test(commit)
  ) {
    throw new SyncError(
      `${POINTER_PATH} at ${rev} needs "repository", "branch" and a full 40-character "commit".`,
    );
  }
  return { repository, branch, commit };
}

function describeCommit(cwd: string, sha: string, repository: string): UpstreamCommit {
  return toUpstreamCommit(sha, git(cwd, ["show", "--no-patch", "--format=%s", sha]), repository);
}

function toUpstreamCommit(sha: string, subject: string, repository: string): UpstreamCommit {
  const number = /\(#(\d+)\)$/.exec(subject)?.[1];
  const web = /^https:\/\/github\.com\/[^/]+\/[^/]+?(?:\.git)?$/.test(repository)
    ? repository.replace(/\.git$/, "")
    : undefined;
  return number && web ? { sha, subject, pullRequest: `${web}/pull/${number}` } : { sha, subject };
}

/** Fetches the upstream branch into a private ref, so no remote has to be configured. */
function fetchUpstream(cwd: string, pointer: UpstreamPointer): string {
  git(cwd, [
    "fetch",
    "--no-tags",
    "--quiet",
    pointer.repository,
    `+refs/heads/${pointer.branch}:${UPSTREAM_REF}`,
  ]);
  return git(cwd, ["rev-parse", UPSTREAM_REF]);
}

function resolveTarget(
  cwd: string,
  pointer: UpstreamPointer,
  options: { readonly to?: string | undefined; readonly fetch?: boolean | undefined },
): string {
  const fetched = options.fetch === false ? undefined : fetchUpstream(cwd, pointer);
  if (options.to !== undefined)
    return git(cwd, ["rev-parse", "--verify", `${options.to}^{commit}`]);
  if (fetched !== undefined) return fetched;
  const known = run(cwd, ["rev-parse", "--quiet", "--verify", UPSTREAM_REF]);
  if (known.status !== 0)
    throw new SyncError("Upstream has not been fetched yet. Run without --no-fetch.");
  return known.stdout.trim();
}

// After a squashed sync the fork has no upstream ancestry, so git's own merge base would be the
// original fork point. The pointer says which upstream commit the fork really contains.
function containedUpstream(cwd: string, head: string, pointer: UpstreamPointer, target: string) {
  const base = isAncestor(cwd, pointer.commit, head)
    ? git(cwd, ["merge-base", head, target])
    : pointer.commit;
  if (!isAncestor(cwd, base, target)) {
    throw new SyncError(
      `Upstream ${short(target)} does not contain ${short(base)}, the commit this fork was last synced to. ` +
        "Upstream history was rewritten, or the target is older than the fork.",
    );
  }
  return base;
}

function upstreamCommits(cwd: string, base: string, target: string): ReadonlyArray<string> {
  return lines(git(cwd, ["rev-list", "--reverse", "--first-parent", `${base}..${target}`]));
}

function tryMerge(cwd: string, base: string, ours: string, theirs: string) {
  const result = run(cwd, [
    "merge-tree",
    "--write-tree",
    "--name-only",
    "--no-messages",
    `--merge-base=${base}`,
    ours,
    theirs,
  ]);
  if (result.status === 0) return { clean: true, files: [] as ReadonlyArray<string> };
  if (result.status !== 1) {
    throw new SyncError(`Trial merge of ${short(theirs)} failed: ${result.stderr.trim()}`);
  }
  // The first line is the tree; the rest name the conflicted files.
  return { clean: false, files: [...new Set(lines(result.stdout).slice(1))] };
}

/**
 * Index of the first commit whose merge conflicts, given that merging through the last one does.
 * A later commit can undo an earlier conflict, so this finds a boundary, which is all a stop needs.
 */
export function firstConflictIndex(count: number, isClean: (index: number) => boolean): number {
  let clean = -1;
  let conflicting = count - 1;
  while (conflicting - clean > 1) {
    const middle = clean + Math.floor((conflicting - clean) / 2);
    if (isClean(middle)) clean = middle;
    else conflicting = middle;
  }
  return conflicting;
}

function statePath(cwd: string) {
  return NodePath.resolve(cwd, git(cwd, ["rev-parse", "--git-path", STATE_FILE]));
}

export function readState(cwd: string): SyncState | undefined {
  const path = statePath(cwd);
  if (!NodeFS.existsSync(path)) return undefined;
  return JSON.parse(NodeFS.readFileSync(path, "utf8")) as SyncState;
}

function writeState(cwd: string, state: SyncState) {
  NodeFS.writeFileSync(statePath(cwd), `${JSON.stringify(state, null, 2)}\n`);
}

function attentionList(
  cwd: string,
  base: string,
  head: string,
  target: string,
  repository: string,
): ReadonlyArray<SyncStop> {
  const forkFiles = new Set(lines(git(cwd, ["diff", "--name-only", "--no-renames", base, head])));
  forkFiles.delete(POINTER_PATH);
  if (forkFiles.size === 0) return [];
  const log = git(cwd, [
    "log",
    "--first-parent",
    "--diff-merges=first-parent",
    "--no-renames",
    "--reverse",
    "--format=%x00%H%x09%s",
    "--name-only",
    `${base}..${target}`,
  ]);
  const attention: Array<SyncStop> = [];
  for (const entry of log.split("\0")) {
    const [header, ...touched] = lines(entry);
    if (header === undefined) continue;
    const files = touched.filter((file) => forkFiles.has(file));
    if (files.length === 0) continue;
    const [sha = "", subject = ""] = header.split("\t");
    attention.push({ commit: toUpstreamCommit(sha, subject, repository), files });
  }
  return attention;
}

/** Reads how far the fork is behind upstream and whether merging would conflict. Changes nothing but the fetched ref. */
export function status(
  cwd: string,
  options: { readonly to?: string | undefined; readonly fetch?: boolean | undefined } = {},
): SyncStatus {
  requireGit(cwd);
  const inProgress = readState(cwd);
  const head = git(cwd, ["rev-parse", "HEAD"]);
  const pointer = readPointer(cwd);
  const target =
    inProgress && options.to === undefined
      ? inProgress.target
      : resolveTarget(cwd, pointer, options);
  const base = containedUpstream(cwd, head, pointer, target);
  const commits = upstreamCommits(cwd, base, target);
  const whole =
    commits.length === 0 ? { clean: true, files: [] } : tryMerge(cwd, base, head, target);
  let firstConflict: SyncStatus["firstConflict"];
  if (!whole.clean) {
    const index = firstConflictIndex(
      commits.length,
      (candidate) => tryMerge(cwd, base, head, commits[candidate]!).clean,
    );
    const culprit = commits[index]!;
    firstConflict = {
      commit: describeCommit(cwd, culprit, pointer.repository),
      files: tryMerge(cwd, base, head, culprit).files,
      cleanBefore: index,
    };
  }
  return {
    pointer,
    head,
    base,
    target,
    behind: commits.length,
    clean: whole.clean,
    ...(firstConflict ? { firstConflict } : {}),
    attention: attentionList(cwd, base, head, target, pointer.repository),
    ...(inProgress ? { inProgress } : {}),
  };
}

function start(
  cwd: string,
  options: { readonly to?: string | undefined; readonly fetch?: boolean | undefined },
): SyncState | undefined {
  const branch = run(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]).stdout.trim();
  if (branch === "" || branch === "main" || branch === "master") {
    throw new SyncError(
      "Run the sync on its own branch (for example sync/upstream), not on the default branch.",
    );
  }
  requireCleanTree(cwd);
  const pointer = readPointer(cwd);
  const target = resolveTarget(cwd, pointer, options);
  const head = git(cwd, ["rev-parse", "HEAD"]);
  const base = containedUpstream(cwd, head, pointer, target);
  if (base === target) return undefined;
  if (!isAncestor(cwd, base, head)) {
    // Same tree as the fork, with the contained upstream commit as a second parent: git then
    // merges later upstream commits against the right base. It is local and never pushed.
    const graft = git(cwd, [
      "commit-tree",
      `${head}^{tree}`,
      "-p",
      head,
      "-p",
      base,
      "-m",
      `sync-upstream: ${branch} already contains upstream through ${short(base)}`,
    ]);
    git(cwd, ["reset", "--soft", graft]);
  }
  const state = { branch, forkBase: head, base, target, stops: [] };
  writeState(cwd, state);
  return state;
}

function unresolvedIn(cwd: string, files: ReadonlyArray<string>) {
  return files.filter((file) => {
    const path = NodePath.join(cwd, file);
    return NodeFS.existsSync(path) && CONFLICT_MARKER.test(NodeFS.readFileSync(path, "utf8"));
  });
}

function settle(cwd: string, state: SyncState) {
  const lastStop = state.stops.at(-1);
  if (mergeInProgress(cwd)) {
    const unmerged = lines(git(cwd, ["diff", "--name-only", "--diff-filter=U"]));
    if (unmerged.length > 0) {
      throw new SyncError(
        `These files still have conflicts. Resolve them and \`git add\` them:\n${unmerged.join("\n")}`,
      );
    }
    if (run(cwd, ["diff", "--quiet"]).status !== 0) {
      throw new SyncError(
        "Some resolved files are not staged. `git add` them, then run merge again.",
      );
    }
  }
  const marked = unresolvedIn(cwd, lastStop?.files ?? []);
  if (marked.length > 0) {
    throw new SyncError(`Conflict markers are still in:\n${marked.join("\n")}`);
  }
  if (mergeInProgress(cwd)) git(cwd, ["commit", "--no-verify", "--no-edit"]);
  requireCleanTree(cwd);
}

function advance(cwd: string, state: SyncState): MergeOutcome {
  const pointer = readPointer(cwd);
  for (;;) {
    const head = git(cwd, ["rev-parse", "HEAD"]);
    if (isAncestor(cwd, state.target, head)) return { kind: "merged", state };
    const base = git(cwd, ["merge-base", head, state.target]);
    const commits = upstreamCommits(cwd, base, state.target);
    const through = (commit: string, count: number) =>
      git(cwd, [
        "merge",
        "--no-ff",
        "--no-verify",
        "--no-edit",
        "-m",
        `Merge upstream through ${short(commit)} (${count} commit${count === 1 ? "" : "s"})`,
        commit,
      ]);
    if (tryMerge(cwd, base, head, state.target).clean) {
      through(state.target, commits.length);
      continue;
    }
    const index = firstConflictIndex(
      commits.length,
      (candidate) => tryMerge(cwd, base, head, commits[candidate]!).clean,
    );
    // Merge the clean stretch first, so the conflict shows only what the one commit changed.
    if (index > 0) through(commits[index - 1]!, index);
    const culprit = describeCommit(cwd, commits[index]!, pointer.repository);
    const merged = run(cwd, [
      "-c",
      "merge.conflictStyle=zdiff3",
      "merge",
      "--no-ff",
      "--no-commit",
      "--no-verify",
      "-m",
      `Merge upstream ${short(culprit.sha)}: ${culprit.subject}`,
      culprit.sha,
    ]);
    if (!mergeInProgress(cwd)) {
      throw new SyncError(`Merging ${short(culprit.sha)} did not start: ${merged.stderr.trim()}`);
    }
    const files = lines(git(cwd, ["diff", "--name-only", "--diff-filter=U"]));
    if (files.length === 0) {
      git(cwd, ["commit", "--no-verify", "--no-edit"]);
      continue;
    }
    const stop = { commit: culprit, files };
    // A stop that was aborted by hand and met again replaces its earlier record.
    const earlier = state.stops.filter((known) => known.commit.sha !== culprit.sha);
    const stopped = { ...state, stops: [...earlier, stop] };
    writeState(cwd, stopped);
    return { kind: "conflict", state: stopped, stop };
  }
}

/**
 * Merges upstream into the current sync branch as far as it goes without a decision. It stops at
 * the first upstream commit that conflicts, with that commit's conflicts in the working tree.
 * Resolve them, `git add` the files, and run it again.
 */
export function merge(
  cwd: string,
  options: { readonly to?: string | undefined; readonly fetch?: boolean | undefined } = {},
): MergeOutcome {
  requireGit(cwd);
  const existing = readState(cwd);
  if (existing === undefined) {
    const started = start(cwd, options);
    return started === undefined
      ? { kind: "up-to-date", pointer: readPointer(cwd) }
      : advance(cwd, started);
  }
  if (options.to !== undefined) {
    throw new SyncError(
      `A sync to ${short(existing.target)} is in progress. Finish or abort it first.`,
    );
  }
  settle(cwd, existing);
  return advance(cwd, existing);
}

/** The fork's own commits that touched a file, newest first, to explain why it differs from upstream. */
export function forkHistory(cwd: string, state: SyncState, file: string): ReadonlyArray<string> {
  return lines(git(cwd, ["log", "--format=%h %s", state.forkBase, "--not", state.base, "--", file]))
    .filter((line) => !line.slice(line.indexOf(" ") + 1).startsWith(SYNC_SUBJECT_PREFIX))
    .slice(0, 5);
}

export function syncMessage(input: {
  readonly repository: string;
  readonly base: string;
  readonly target: string;
  readonly count: number;
  readonly stops: ReadonlyArray<SyncStop>;
}): { readonly title: string; readonly body: string } {
  const plural = input.count === 1 ? "" : "s";
  const conflicts =
    input.stops.length === 0
      ? ["No conflicts."]
      : [
          `Conflicts resolved (${input.stops.length}):`,
          ...input.stops.flatMap((stop) => [
            `- ${short(stop.commit.sha)} ${stop.commit.subject}`,
            ...stop.files.map((file) => `    ${file}`),
          ]),
        ];
  return {
    title: `${SYNC_SUBJECT_PREFIX}${short(input.target)} (${input.count} commit${plural})`,
    body: [
      `Upstream: ${input.repository} ${short(input.base)}..${short(input.target)}`,
      "",
      ...conflicts,
      "",
      `Upstream-Commit: ${input.target}`,
    ].join("\n"),
  };
}

const REPORT_DIFF_LINES = 150;

function syncReport(
  cwd: string,
  state: SyncState,
  pointer: UpstreamPointer,
  detailRef: string,
  count: number,
): string {
  const link = (commit: UpstreamCommit) =>
    commit.pullRequest
      ? `[\`${short(commit.sha)}\`](${commit.pullRequest}) ${commit.subject}`
      : `\`${short(commit.sha)}\` ${commit.subject}`;
  const range = `${state.forkBase}..${detailRef}`;
  const merges = lines(git(cwd, ["rev-list", "--first-parent", "--merges", range]));
  const resolutions = state.stops.flatMap((stop) => {
    const merge = merges.find(
      (candidate) => git(cwd, ["rev-parse", `${candidate}^2`]) === stop.commit.sha,
    );
    const diff = merge ? lines(git(cwd, ["show", "--remerge-diff", "--format=", merge])) : [];
    const shown = diff.slice(0, REPORT_DIFF_LINES);
    if (diff.length > shown.length) shown.push(`... ${diff.length - shown.length} more lines`);
    return [
      `### ${link(stop.commit)}`,
      "",
      ...stop.files.map((file) => `- \`${file}\``),
      "",
      "<details><summary>Resolution</summary>",
      "",
      "```diff",
      ...shown,
      "```",
      "",
      "</details>",
      "",
    ];
  });
  // What the agent committed on top of the merges to keep the fork working.
  const adaptations = lines(
    git(cwd, ["log", "--first-parent", "--no-merges", "--format=- `%h` %s", range]),
  ).filter((line) => !line.includes("sync: record upstream "));
  const attention = attentionList(
    cwd,
    state.base,
    state.forkBase,
    state.target,
    pointer.repository,
  );
  return [
    `Upstream \`${short(state.base)}..${short(state.target)}\`: ${count} commit${count === 1 ? "" : "s"}.`,
    "",
    `## Conflicts resolved (${state.stops.length})`,
    "",
    ...(state.stops.length === 0 ? ["None.", ""] : resolutions),
    `## Adaptations after merging (${adaptations.length})`,
    "",
    ...(adaptations.length === 0 ? ["None."] : adaptations),
    "",
    `## Upstream changes to files the fork has changed (${attention.length})`,
    "",
    ...(attention.length === 0
      ? ["None."]
      : attention.map(
          (entry) =>
            `- ${link(entry.commit)}: ${entry.files.map((file) => `\`${file}\``).join(", ")}`,
        )),
    "",
  ].join("\n");
}

/**
 * Records the new upstream commit in the pointer and, unless `keepMerges`, collapses the sync into
 * one commit on the fork so it can land through a squash merge.
 */
export function finish(cwd: string, options: { readonly keepMerges?: boolean } = {}): FinishResult {
  const state = readState(cwd);
  if (state === undefined) throw new SyncError("No sync is in progress on this checkout.");
  if (mergeInProgress(cwd)) throw new SyncError("A merge is still open. Run merge again first.");
  requireCleanTree(cwd);
  if (!isAncestor(cwd, state.target, "HEAD")) {
    throw new SyncError(
      `Upstream ${short(state.target)} is not fully merged yet. Run merge again.`,
    );
  }
  const pointer = readPointer(cwd);
  NodeFS.writeFileSync(
    NodePath.join(cwd, POINTER_PATH),
    `${JSON.stringify({ ...pointer, commit: state.target }, null, 2)}\n`,
  );
  git(cwd, ["add", "--", POINTER_PATH]);
  git(cwd, ["commit", "--no-verify", "-m", `sync: record upstream ${short(state.target)}`]);

  const detailRef = `${DETAIL_REF_PREFIX}${short(state.target)}`;
  git(cwd, ["update-ref", detailRef, "HEAD"]);
  const count = upstreamCommits(cwd, state.base, state.target).length;
  const message = syncMessage({
    repository: pointer.repository,
    base: state.base,
    target: state.target,
    count,
    stops: state.stops,
  });
  const report = syncReport(cwd, state, pointer, detailRef, count);
  if (!options.keepMerges) {
    const squashed = git(
      cwd,
      ["commit-tree", "HEAD^{tree}", "-p", state.forkBase, "-F", "-"],
      `${message.title}\n\n${message.body}\n`,
    );
    git(cwd, ["reset", "--soft", squashed]);
  }
  NodeFS.rmSync(statePath(cwd), { force: true });
  return {
    commit: git(cwd, ["rev-parse", "HEAD"]),
    ...message,
    detailRef,
    squashed: !options.keepMerges,
    report,
  };
}

/** Drops a sync in progress and puts the branch back where it started. */
export function abort(cwd: string): SyncState {
  const state = readState(cwd);
  if (state === undefined) throw new SyncError("No sync is in progress on this checkout.");
  const branch = run(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]).stdout.trim();
  if (branch !== state.branch) {
    throw new SyncError(`The sync in progress belongs to ${state.branch}, not ${branch}.`);
  }
  if (mergeInProgress(cwd)) git(cwd, ["merge", "--abort"]);
  git(cwd, ["reset", "--hard", state.forkBase]);
  NodeFS.rmSync(statePath(cwd), { force: true });
  return state;
}
