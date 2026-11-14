---
name: sync-upstream
description: Bring upstream T3 Code's new commits into this fork. Merge them with scripts/sync-upstream.ts, resolve each conflict against the upstream pull request and fork/README.md, open the sync pull request on 1001-ai/1001-code, and verify through its CI. Use when asked to sync, update from, pull in, or merge upstream.
---

# Sync upstream

Read [fork/README.md](../../../fork/README.md) first. It explains why a sync is not a plain `git merge`, and it lists every place this fork differs from upstream with what has to survive a conflict.

A sync succeeds when the fork has all of upstream's new behavior and still has all of its own. One that merges cleanly but quietly drops either has failed.

## Never run upstream's code here

Once `merge` runs, the sync branch holds upstream code that nobody here has read. On the sync branch, on any machine with credentials (SSH keys, `gh` or cloud tokens, a T3 home), do only text work: read, merge, edit, commit, push.

- Do not run `vp i`, `vp run`, tests, builds, generators, or any script from the repository. Each of them runs upstream's code.
- Disable git hooks on every git command you run there: `git -c core.hooksPath=/dev/null <command>`. Hooks are scripts in the working tree, which on this branch are upstream's. The tool already does this for its own git commands.
- `node scripts/sync-upstream.ts` is the exception: it is the fork's own code, and it refuses to merge an upstream change to its own files.
- The fork's CI checks the pull request on GitHub's runners, which hold no secrets. If something has to run before that, run it in a disposable environment without credentials, such as a fresh container or VM with no keys or tokens and no T3 home, and bring back only text you have read.

## 1. Start

Work in your own worktree on a new branch from `origin/main`. Never sync in a checkout someone is using, and never on `main`. Do not run `vp i` in it; the tool needs only `node`, `git` and `gh`.

```sh
git fetch origin main
git worktree add ../1001-code-sync -b sync/upstream-$(date +%Y%m%d) origin/main
cd ../1001-code-sync
node scripts/sync-upstream.ts status
```

`status` changes nothing. It names the target and why it was chosen, says how many upstream commits are waiting, whether they merge cleanly, which commit conflicts first, and which upstream commits touch files the fork has changed.

The target sits in quarantine: the newest upstream commit at least three days old whose `Check` job passed on upstream's CI. If nothing passes yet, say so and stop. If the tool cannot read upstream's CI, it refuses; fix the cause (usually `gh auth status`) or stop and report. Pass `--to <commit>` only for a commit a human named, for example a release tag; it skips quarantine.

If a sync pull request is already open on `1001-ai/1001-code`, finish or close that one first: two open syncs disagree about the pointer.

## 2. Merge

```sh
node scripts/sync-upstream.ts merge
```

Exit code 0 means everything is merged. Exit code 2 means it stopped at one upstream commit whose conflicts are now in the working tree. For each conflicted file:

1. **Read what upstream changed and why.** `git show <commit> -- <file>`, and `gh pr view <number> -R pingdotgg/t3code` when the diff does not explain itself.
2. **Read why the fork differs.** The tool prints the fork commits that touched the file. Find the file's entry in `fork/README.md`.
3. **Write the version that keeps both.** The conflict shows three sides: the fork's, what both started from, and upstream's.
   - Upstream changed code around a fork change: take upstream's code and re-apply the fork's change to it.
   - Upstream changed the same lines: apply what upstream meant to the fork's version.
   - Upstream changed a file the fork deleted or replaced: keep the fork's choice. Then port the change to the fork's replacement if it fixes something both share, and say in the report whether you did.
   - A generated or binary file (`pnpm-lock.yaml`, `*.gen.ts`, icons): never merge it by hand. Take upstream's with `git -c core.hooksPath=/dev/null checkout --theirs -- <file>`. Regenerating it runs the repository's code, so not here: if the fork's own changes need it regenerated, say so in the report, and it is done in a disposable environment.
4. `git -c core.hooksPath=/dev/null add` the file.

Then run `merge` again. It commits the resolution and carries on to the next conflict or the end.

Never resolve with `-X ours`, `-X theirs`, `git checkout --ours .`, or by dropping a side you did not understand. If one conflict cannot keep both intentions, stop with the merge open and tell the human what upstream did, what the fork needs, and the options. `node scripts/sync-upstream.ts abort` puts the branch back where it started.

## 3. Finish and open the pull request

```sh
node scripts/sync-upstream.ts finish
git -c core.hooksPath=/dev/null push -u origin HEAD
gh pr create -R 1001-ai/1001-code --base main --title "<the title finish printed>" --body-file <the report path finish printed>
```

`finish` makes the sync one merge commit whose parents are the fork's starting point and the upstream target, and writes the report.

- **Always pass `-R 1001-ai/1001-code`.** Plain `gh` here targets upstream, and a sync must never become a pull request against `pingdotgg/t3code`.
- Before opening it, edit the report:
  - **Sensitive changes**, at the top: read the diff of each listed file and add a line per group saying what changed and whether it matches what its upstream pull request says. If anything looks wrong, such as a new package nobody asked for, a script that downloads something, or an endpoint that moved, stop and tell the human instead of opening the pull request.
  - Under each resolution, say in a sentence or two what you kept from each side.
- If the sync added a file under `.github/workflows/`, it is enabled on GitHub as soon as it merges. Say so in the report, so it is disabled after merge as the divergence "Only CI workflows are enabled on GitHub" describes.

## 4. Verify through CI

The fork's CI is the test run. Wait for it with `gh pr checks <number> -R 1001-ai/1001-code --watch`, and read a failure with `gh run view <run> -R 1001-ai/1001-code --log-failed`.

- Run the **Check** of every divergence in `fork/README.md` that only reads files (`grep`, `git`). The ones that run tools are covered by CI.
- For every commit under "Upstream changes to files the fork has changed" in the report, read the upstream change and confirm the fork's change still does its job. These merged without a conflict, and that proves nothing.
- Add a `## Verification` section to the pull request body with what CI reported and what you checked by reading.

Fix what the sync broke in ordinary commits on the sync branch, one per problem, with normal messages, and push them; CI runs again. If a fix is large or changes what a fork feature does, stop and report instead.

## 5. Landing

- The pull request lands with **Create a merge commit**, never a squash: the merge commit is what keeps upstream's history in `main`. Leave merging to the human unless you were told to merge, and then use `gh pr merge <number> -R 1001-ai/1001-code --merge`.
- If `main` moved while you worked and the pull request conflicts, start over from the new `main`. A sync is cheap to redo and wrong to patch.

Remove the worktree when the pull request is open: `git worktree remove ../1001-code-sync`.
