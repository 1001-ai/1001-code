# 1001 Code is a fork of T3 Code

This repository is [pingdotgg/t3code](https://github.com/pingdotgg/t3code) plus 1001's changes. Upstream lands more than a hundred commits a day and we want all of them. Two things make that possible: how upstream gets merged, and how we write our own changes.

## How upstream gets in

[upstream.json](upstream.json) names the upstream commit this fork already contains. `node scripts/sync-upstream.ts` merges everything upstream has added since and moves that pointer. To run a sync, ask an agent to "sync upstream"; it follows the [sync-upstream skill](../.agents/skills/sync-upstream/SKILL.md).

- **Each sync lands as one squashed commit.** The 1001 organization allows only squash merges into the default branch, so `main` holds upstream's changes without upstream's commits. Git alone can no longer tell what has been merged; the pointer can.
- **Never run `git merge upstream/main`, and never press "Sync fork" on GitHub.** Both ignore the pointer and try to merge everything since the fork began, which conflicts in thousands of files.
- **The tool stops at the one upstream commit that conflicts.** It merges as far as it can without a decision, so every conflict arrives with the pull request that caused it, and a clean day needs no decisions at all.
- **A clean merge is not proof.** Upstream can change what a fork feature stands on without touching the same lines. `status` and the sync report list every upstream commit that touches a file the fork has changed, and the fork's own tests run on every sync.

Upstream's full history stays available for blame and bisecting at `refs/sync-upstream/upstream` after any `status` or `merge`.

## Rules for our changes

A textual conflict costs an agent minutes. A fork change that nobody can explain costs far more, at every sync, forever.

1. **Add, don't edit.** New behavior goes in new files. Where upstream's code has to call it, change as few of upstream's lines as you can.
2. **Leave upstream's code alone around your change.** No reformatting, renaming, reordering or moving code in a file upstream owns. Each of those turns upstream's next edit into a conflict that carries no meaning.
3. **Never add a numbered database migration.** Upstream owns that sequence, and a fork migration that takes the next number stops the server starting once upstream uses it. Fork tables need their own migration lane.
4. **Test what you add.** Upstream's tests do not know about our features. Without a test, a fork feature breaks silently the day upstream changes something under it.
5. **Record every divergence below, in the pull request that makes it.** The entry is what lets an agent, months later, resolve a conflict in your code the way you would have.

## Divergences

One entry for each place this fork changes a file upstream owns, or replaces something upstream does. Files that only exist here need no entry.

### Fork notice in the agent instructions

- **Where:** `AGENTS.md`, the quoted line under the title.
- **Why:** every agent reads `AGENTS.md` first, so it is the one place that can send them to this page.
- **On conflict:** take upstream's text and put the line back under the title.
- **Check:** `grep -n "fork/README.md" AGENTS.md`

### Sync script is a knip entry

- **Where:** `knip.jsonc`, `"sync-upstream.ts"` in the `scripts` workspace's `entry` list.
- **Why:** the script is run by path, which knip cannot trace, so it would be reported as an unused file.
- **On conflict:** take upstream's list and add the entry back.
- **Check:** `vp run knip:check:files`

### CI runs on GitHub's runners

- **Where:** `.github/workflows/ci.yml`, every `runs-on:` line. Upstream uses Blacksmith runners, which this repository does not have, so its jobs queued forever. Linux jobs run on `ubuntu-24.04`, the macOS lint on `macos-26`. Both are free for public repositories.
- **Why:** without this, nothing checks a pull request here, including a sync.
- **On conflict:** take upstream's file and put the runner labels back. A new job upstream adds needs the same change.
- **Check:** `grep -n "runs-on:" .github/workflows/ci.yml | grep -v -E "ubuntu-24.04|macos-26"` prints nothing.

### Only CI workflows are enabled on GitHub

- **Where:** the repository's Actions settings, not a file. Only `CI` and `Agent Context Budget` are enabled; every other upstream workflow is disabled with `gh workflow disable -R 1001-ai/1001-code <name>`.
- **Why:** the rest publish upstream's releases and previews or moderate upstream's contributors (closing pull requests, labelling, commenting). Several run on `pull_request_target` with a write token, which a public repository should not run for pull requests it does not control.
- **On conflict:** none, but GitHub enables a new workflow file as soon as a sync brings it in.
- **Check:** `gh workflow list -R 1001-ai/1001-code` lists only `CI` and `Agent Context Budget`. Disable anything else unless it is a check this fork wants, and add it here if so.
