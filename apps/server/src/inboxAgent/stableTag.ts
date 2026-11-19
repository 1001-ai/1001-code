import type { RepositoryIdentity } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type * as ProcessRunner from "../processRunner.ts";

/**
 * The project's `stable` tag on its origin: a team moves it to the build their update command
 * installs. The server asks the remote itself, so a move is seen however it was made.
 */
const STABLE_TAG = "stable";
export const STABLE_CHECK_INTERVAL_MS = 10 * 60_000;
const GIT_TIMEOUT = "30 seconds";
const MAX_PULL_REQUESTS = 30;

export interface StablePullRequest {
  readonly number: number;
  readonly title: string;
}

/** The commit `stable` names in `git ls-remote --tags` output: the peeled one for an annotated tag. */
export function stableCommitOf(lsRemote: string): string | null {
  let direct: string | null = null;
  for (const line of lsRemote.split("\n")) {
    const [sha, ref] = line.trim().split(/\s+/);
    if (sha === undefined || !/^[0-9a-f]{40,64}$/.test(sha)) continue;
    if (ref === `refs/tags/${STABLE_TAG}^{}`) return sha;
    if (ref === `refs/tags/${STABLE_TAG}`) direct = sha;
  }
  return direct;
}

/**
 * The pull requests in `git log --first-parent --format=%s` subjects, by the `(#123)` a squash
 * merge ends its title with; first-parent keeps a merged-in history's own numbers out. Oldest first.
 */
export function stablePullRequestsOf(subjects: string): ReadonlyArray<StablePullRequest> {
  const byNumber = new Map<number, string>();
  for (const subject of subjects.split("\n")) {
    const match = /^(.*?)\s*\(#(\d+)\)\s*$/.exec(subject.trim());
    if (match === null) continue;
    const title = (match[1] ?? "").replace(/^[a-z]+(?:\([^)]*\))?!?:\s*/i, "");
    byNumber.set(Number(match[2]), title);
  }
  return [...byNumber]
    .toSorted(([left], [right]) => left - right)
    .slice(-MAX_PULL_REQUESTS)
    .map(([number, title]) => ({ number, title }));
}

/** Where a GitHub repository's pull requests live, or null for another host. */
export function stableRepositoryWebUrl(
  identity: Pick<RepositoryIdentity, "canonicalKey" | "provider" | "displayName"> | null,
): string | null {
  if (identity?.provider !== "github") return null;
  const [host, ...path] = identity.canonicalKey.split("/");
  const repository = identity.displayName ?? path.join("/");
  return host === undefined || repository === "" ? null : `https://${host}/${repository}`;
}

export class StableTagReadError extends Schema.TaggedError<StableTagReadError>()(
  "StableTagReadError",
  { detail: Schema.String },
) {}

type Run = ProcessRunner.ProcessRunner["Service"]["run"];

/** The commit `stable` names on origin, or null without one; fails when origin cannot be read. */
export const readStableCommit = Effect.fn("StableTag.read")(function* (
  run: Run,
  cwd: string,
  env: NodeJS.ProcessEnv,
) {
  const output = yield* run({
    command: "git",
    args: [
      "ls-remote",
      "--tags",
      "--",
      "origin",
      `refs/tags/${STABLE_TAG}`,
      `refs/tags/${STABLE_TAG}^{}`,
    ],
    cwd,
    env,
    timeout: GIT_TIMEOUT,
  });
  if (output.code !== 0)
    return yield* new StableTagReadError({
      detail: output.stderr.trim() || "git ls-remote failed",
    });
  return stableCommitOf(output.stdout);
});

/**
 * The pull requests between two `stable` commits. Fetches the new one without touching the
 * checkout's refs or FETCH_HEAD; an unreadable range gives no list rather than a wrong one.
 */
export const readStablePullRequests = Effect.fn("StableTag.pullRequests")(function* (
  run: Run,
  cwd: string,
  env: NodeJS.ProcessEnv,
  range: { readonly from: string; readonly to: string },
) {
  const git = (args: ReadonlyArray<string>) =>
    run({ command: "git", args, cwd, env, timeout: GIT_TIMEOUT });
  yield* git([
    "fetch",
    "--quiet",
    "--no-tags",
    "--no-write-fetch-head",
    "--",
    "origin",
    `refs/tags/${STABLE_TAG}`,
  ]);
  const log = yield* git([
    "log",
    "--first-parent",
    "--format=%s",
    `${range.from}..${range.to}`,
    "--",
  ]);
  return log.code === 0 ? stablePullRequestsOf(log.stdout) : [];
});
