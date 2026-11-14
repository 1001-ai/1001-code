# 1001 Code is a fork of T3 Code

This repository is [pingdotgg/t3code](https://github.com/pingdotgg/t3code) plus 1001's changes. Upstream lands more than a hundred commits a day and we want all of them. Two things make that possible: how upstream gets merged, and how we write our own changes.

## How upstream gets in

[upstream.json](upstream.json) names the upstream commit this fork already contains. `node scripts/sync-upstream.ts` merges everything upstream has added since and moves that pointer. To run a sync, ask an agent to "sync upstream"; it follows the [sync-upstream skill](../.agents/skills/sync-upstream/SKILL.md).

- **Each sync lands as one merge commit.** Its parents are the fork's `main` and the upstream commit it syncs to, so `main` keeps upstream's history and `git blame` and `git bisect` see upstream's own commits. Land a sync pull request with **Create a merge commit**. A squash merge drops that history; the next sync still works, because the pointer records what was merged, but blame and bisect lose upstream's commits.
- **Use the tool, not `git merge upstream/main` or GitHub's "Sync fork".** With upstream's history in `main` a plain merge would apply, but it takes upstream's newest commit, skips the checks below and leaves the pointer behind.
- **Upstream code waits before it comes in.** Without `--to`, a sync targets the newest upstream commit at least three days old (`--min-age-days`) whose `Check` job passed on upstream's CI when it was pushed to upstream's `main`, also at least three days ago. A bad commit gets those days to be noticed upstream before it reaches the fork. If the tool cannot read upstream's CI, it refuses to choose rather than guess; `--to <commit>` names a target someone has checked by hand.
- **Upstream code never runs on a machine with credentials.** Between merge and review, the sync branch holds upstream code nobody here has read. The agent that syncs merges text and resolves conflicts; it does not install, build, test or run repository scripts on that branch. The tool turns git hooks off for its own git commands and refuses an upstream change to its own files. The fork's CI runs the checks on GitHub's runners, which hold no secrets. Anything that has to run before that happens in a disposable environment without credentials.
- **The pull request opens with the sensitive changes.** `finish` lists every upstream-changed file that matches a sensitive rule, grouped by why: dependencies added to the lockfile, install-time build permissions and release age, package scripts and lifecycle hooks, CI workflows, agent instructions, update and release URLs, telemetry, auth and secrets code, Dockerfiles, and setup scripts and git hooks. The rules are in [sensitive-changes.ts](../scripts/lib/sensitive-changes.ts).
- **The tool stops at the one upstream commit that conflicts.** It merges as far as it can without a decision, so every conflict arrives with the pull request that caused it, and a clean day needs no decisions at all.
- **A clean merge is not proof.** Upstream can change what a fork feature stands on without touching the same lines. `status` and the sync report list every upstream commit that touches a file the fork has changed, and the fork's CI runs on every sync.

The newest fetched upstream stays at `refs/sync-upstream/upstream` after any `status` or `merge`, and each sync's step-by-step merges at `refs/sync-upstream/detail/<commit>` in the checkout that ran it.

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

### Sending while scrolled up keeps your place

- **Where:** `apps/web/src/components/chat/useTimelineFollow.ts` (one guard at the top of `anchorNewTurn`, and the new `scrollOnSend` it returns), `apps/web/src/components/ChatView.tsx` (destructures `scrollOnSend` and passes it as `scrollToEnd` to `useThreadLifecycle` and `useComposerResume`, which scroll after `/compact`, goal commands and resume). The rule itself is `sendKeepsReaderPlace` in `chat/sendKeepsPlace.logic.ts`, a fork-only file.
- **Why:** upstream jumps the timeline to every new turn the reader sends, so replying while reading an earlier response loses their place. Here a send from a reader who has scrolled away from the live end leaves the viewport alone; the message still appears at the end and the scroll-to-bottom pill stays up. A reader following the end, or still at it, gets upstream's behaviour. The guest page keeps upstream's behaviour on purpose: a guest's message waits for the owner, and upstream's `GuestPage.browser.test.tsx` asserts it comes into view.
- **On conflict:** take upstream's code and put the guard and the `scrollOnSend` calls back. If upstream adds another send path that anchors or scrolls to the end, route it through `sendKeepsReaderPlace` too. If upstream changes `TimelineFollow`, update `sendKeepsReaderPlace` and its test.
- **Check:** `grep -rn "sendKeepsReaderPlace\|scrollOnSend" apps/web/src` shows the guard, `scrollOnSend` and its two uses in `ChatView.tsx`, and the logic file; `vp test run apps/web/src/components/chat/sendKeepsPlace.logic.test.ts` passes.
