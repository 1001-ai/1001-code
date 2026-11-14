// @effect-diagnostics nodeBuiltinImport:off globalDate:off - plain synchronous Node with no Effect runtime.
import * as NodeChildProcess from "node:child_process";

/** Upstream's CI verdict on one commit. `since` is when the commit's run on the branch started, in epoch seconds. */
export type CiResult =
  | { readonly passed: true; readonly since: number }
  | { readonly passed: false; readonly detail: string };

/** Reads upstream CI for a commit. Throws when the result cannot be read, so callers fail closed. */
export type CiLookup = (sha: string) => CiResult;

export interface Candidate {
  readonly sha: string;
  /** Committer date, epoch seconds. */
  readonly committedAt: number;
}

export interface QuarantineOptions {
  readonly minAgeDays: number;
  readonly ci: CiLookup;
  /** Epoch seconds. */
  readonly now: number;
  readonly maxLookups?: number;
}

export type Selection =
  | { readonly kind: "chosen"; readonly sha: string; readonly reason: string }
  | { readonly kind: "none"; readonly reason: string }
  | { readonly kind: "unreadable"; readonly sha: string; readonly error: string };

const DAY = 24 * 60 * 60;
const DEFAULT_MAX_LOOKUPS = 20;
const date = (seconds: number) =>
  new Date(seconds * 1000).toISOString().slice(0, 16).replace("T", " ");
const short = (sha: string) => sha.slice(0, 10);

/**
 * Picks the newest candidate that is old enough and passed upstream CI on the branch long enough
 * ago. Candidates come newest first. Age is checked twice: the committer date, which is free but
 * can be forged, and when CI ran on the branch, which shows when the commit really landed there.
 */
export function selectTarget(
  candidates: ReadonlyArray<Candidate>,
  options: QuarantineOptions,
): Selection {
  const cutoff = options.now - options.minAgeDays * DAY;
  const days = `${options.minAgeDays} day${options.minAgeDays === 1 ? "" : "s"}`;
  const old = candidates.filter((candidate) => candidate.committedAt <= cutoff);
  const tooNew = candidates.length - old.length;
  const skipped: Array<string> = [];
  if (tooNew > 0) skipped.push(`${tooNew} committed less than ${days} ago`);
  const budget = options.maxLookups ?? DEFAULT_MAX_LOOKUPS;
  for (const candidate of old.slice(0, budget)) {
    let result: CiResult;
    try {
      result = options.ci(candidate.sha);
    } catch (error) {
      return {
        kind: "unreadable",
        sha: candidate.sha,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    if (!result.passed) {
      skipped.push(`${short(candidate.sha)}: ${result.detail}`);
      continue;
    }
    if (result.since > cutoff) {
      skipped.push(`${short(candidate.sha)}: CI ran on the branch less than ${days} ago`);
      continue;
    }
    return {
      kind: "chosen",
      sha: candidate.sha,
      reason:
        `${short(candidate.sha)} is the newest upstream commit at least ${days} old ` +
        `(committed ${date(candidate.committedAt)} UTC) whose "Check" passed on the branch ` +
        `(run started ${date(result.since)} UTC).` +
        (skipped.length > 0 ? ` Skipped newer commits: ${skipped.join("; ")}.` : ""),
    };
  }
  const reasons = [...skipped];
  if (old.length > budget) reasons.push(`stopped after checking CI for ${budget} commits`);
  return {
    kind: "none",
    reason:
      candidates.length === 0
        ? "Upstream has no new commits."
        : `No new upstream commit passes quarantine (at least ${days} old with a passing "Check"): ${reasons.join("; ")}.`,
  };
}

interface CheckRun {
  readonly name?: string;
  readonly head_sha?: string;
  readonly status?: string;
  readonly conclusion?: string | null;
  readonly details_url?: string;
  readonly app?: { readonly slug?: string } | null;
}

interface WorkflowRun {
  readonly event?: string;
  readonly head_branch?: string;
  readonly head_sha?: string;
  readonly created_at?: string;
}

function ghApi(endpoint: string): unknown {
  const result = NodeChildProcess.spawnSync("gh", ["api", endpoint], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw new Error(`could not run gh: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`gh api ${endpoint} failed: ${result.stderr.trim() || result.stdout.trim()}`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`gh api ${endpoint} did not return JSON`);
  }
}

/**
 * Reads the "Check" job from GitHub Actions through `gh api`. A pass counts only when the run came
 * from a push to `branch`, so a commit that passed CI on a pull request long ago and was pushed to
 * the branch today is still new.
 */
export function githubActionsCheck(
  repository: string,
  branch: string,
  checkName = "Check",
): CiLookup {
  const slug = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(repository)?.[1];
  return (sha) => {
    if (slug === undefined) throw new Error(`${repository} is not a GitHub repository`);
    const response = ghApi(
      `repos/${slug}/commits/${sha}/check-runs?check_name=${encodeURIComponent(checkName)}&filter=latest&per_page=100`,
    ) as { readonly check_runs?: ReadonlyArray<CheckRun> };
    if (!Array.isArray(response.check_runs)) throw new Error("unexpected check-runs response");
    const runs = response.check_runs.filter(
      (run) => run.name === checkName && run.app?.slug === "github-actions" && run.head_sha === sha,
    );
    if (runs.length === 0) return { passed: false, detail: `no "${checkName}" run` };
    for (const run of runs) {
      if (run.status !== "completed" || run.conclusion !== "success") continue;
      const id = /\/actions\/runs\/(\d+)\//.exec(run.details_url ?? "")?.[1];
      if (id === undefined) continue;
      const workflow = ghApi(`repos/${slug}/actions/runs/${id}`) as WorkflowRun;
      const since = Date.parse(workflow.created_at ?? "");
      if (
        workflow.event === "push" &&
        workflow.head_branch === branch &&
        workflow.head_sha === sha &&
        Number.isFinite(since)
      ) {
        return { passed: true, since: Math.floor(since / 1000) };
      }
    }
    if (runs.some((run) => run.status !== "completed")) {
      return { passed: false, detail: `"${checkName}" is still running` };
    }
    if (runs.some((run) => run.conclusion === "success")) {
      return { passed: false, detail: `"${checkName}" passed, but not on a push to ${branch}` };
    }
    return {
      passed: false,
      detail: `"${checkName}" ${runs.map((run) => run.conclusion ?? "unknown").join(", ")}`,
    };
  };
}
