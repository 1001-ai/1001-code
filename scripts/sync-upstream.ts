#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off
// Brings upstream's changes into this fork. See fork/README.md for the model and
// .agents/skills/sync-upstream for the procedure an agent follows.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import {
  abort,
  finish,
  forkHistory,
  merge,
  status,
  SyncError,
  type SyncState,
  type SyncStop,
  type UpstreamCommit,
} from "./lib/upstream-sync.ts";

const USAGE = `node scripts/sync-upstream.ts <command>

  status [--to <rev>] [--no-fetch] [--json]
      How far behind upstream this checkout is, whether merging conflicts, and which
      upstream commits touch files the fork has changed. Changes nothing.
  merge [--to <rev>] [--no-fetch]
      Run on a sync branch with a clean tree. Merges upstream until it is done or an
      upstream commit conflicts (exit code 2). Resolve, git add, and run it again.
  finish [--keep-merges]
      Records the new upstream commit and squashes the sync into one commit.
  abort
      Drops a sync in progress and resets the branch to where it started.`;

const short = (sha: string) => sha.slice(0, 10);
const describe = (commit: UpstreamCommit) =>
  `${short(commit.sha)} ${commit.subject}${commit.pullRequest ? `\n    ${commit.pullRequest}` : ""}`;

function printStop(cwd: string, state: SyncState, stop: SyncStop) {
  console.log(`Stopped at upstream commit ${describe(stop.commit)}\n`);
  console.log("Conflicted files, with the fork commits that changed each one:");
  for (const file of stop.files) {
    console.log(`  ${file}`);
    for (const line of forkHistory(cwd, state, file)) console.log(`      ${line}`);
  }
  console.log(
    [
      "",
      `See what upstream changed:   git show ${short(stop.commit.sha)} -- <file>`,
      "See the conflict three ways: git diff",
      "Then resolve each file, `git add` it, and run `node scripts/sync-upstream.ts merge` again.",
    ].join("\n"),
  );
}

function main(): number {
  const { values, positionals } = NodeUtil.parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      to: { type: "string" },
      "no-fetch": { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      "keep-merges": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const [command] = positionals;
  if (values.help || command === undefined) {
    console.log(USAGE);
    return command === undefined && !values.help ? 1 : 0;
  }
  const cwd = NodeChildProcess.execFileSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  }).trim();
  const target = { to: values.to, fetch: !values["no-fetch"] };

  switch (command) {
    case "status": {
      const result = status(cwd, target);
      if (values.json) {
        console.log(JSON.stringify(result, null, 2));
        return 0;
      }
      console.log(
        `Fork contains upstream through ${short(result.base)}. Upstream is at ${short(result.target)}: ${result.behind} commit${result.behind === 1 ? "" : "s"} to merge.`,
      );
      if (result.inProgress) {
        console.log(
          `A sync to ${short(result.inProgress.target)} is in progress on ${result.inProgress.branch} (${result.inProgress.stops.length} conflict stop${result.inProgress.stops.length === 1 ? "" : "s"} so far).`,
        );
      }
      if (result.behind === 0) return 0;
      if (result.firstConflict) {
        console.log(
          `\nNot clean. ${result.firstConflict.cleanBefore} commit${result.firstConflict.cleanBefore === 1 ? "" : "s"} merge cleanly, then this one conflicts:`,
        );
        console.log(`  ${describe(result.firstConflict.commit)}`);
        for (const file of result.firstConflict.files) console.log(`      ${file}`);
      } else {
        console.log("\nMerges cleanly.");
      }
      if (result.attention.length > 0) {
        console.log(
          `\nUpstream commits that touch files the fork has changed (${result.attention.length}):`,
        );
        for (const entry of result.attention) {
          console.log(`  ${describe(entry.commit)}`);
          for (const file of entry.files) console.log(`      ${file}`);
        }
      }
      return 0;
    }
    case "merge": {
      const outcome = merge(cwd, target);
      if (outcome.kind === "up-to-date") {
        console.log(
          `Already contains upstream ${short(outcome.pointer.commit)}. Nothing to merge.`,
        );
        return 0;
      }
      if (outcome.kind === "conflict") {
        printStop(cwd, outcome.state, outcome.stop);
        return 2;
      }
      console.log(
        `Upstream ${short(outcome.state.target)} is merged (${outcome.state.stops.length} conflict stop${outcome.state.stops.length === 1 ? "" : "s"}). Verify the result, then run \`node scripts/sync-upstream.ts finish\`.`,
      );
      return 0;
    }
    case "finish": {
      const result = finish(cwd, { keepMerges: values["keep-merges"] });
      console.log(`${result.title}\n\n${result.body}\n`);
      console.log(
        result.squashed
          ? `Squashed into ${short(result.commit)}. The step-by-step merges are kept at ${result.detailRef}.`
          : `Kept the merge commits. HEAD is ${short(result.commit)}.`,
      );
      const reportPath = NodePath.resolve(
        cwd,
        NodeChildProcess.execFileSync(
          "git",
          ["rev-parse", "--git-path", "sync-upstream-report.md"],
          {
            cwd,
            encoding: "utf8",
          },
        ).trim(),
      );
      NodeFS.writeFileSync(reportPath, result.report);
      console.log(`Pull request body with each resolution: ${reportPath}`);
      return 0;
    }
    case "abort": {
      const state = abort(cwd);
      console.log(
        `Dropped the sync to ${short(state.target)}. ${state.branch} is back at ${short(state.forkBase)}.`,
      );
      return 0;
    }
    default:
      console.error(`Unknown command "${command}".\n\n${USAGE}`);
      return 1;
  }
}

try {
  process.exitCode = main();
} catch (error) {
  if (!(error instanceof SyncError)) throw error;
  console.error(`sync-upstream: ${error.message}`);
  process.exitCode = 1;
}
