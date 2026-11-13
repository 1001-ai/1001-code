---
name: sync-upstream
description: Bring upstream T3 Code's new commits into this fork. Merge them with scripts/sync-upstream.ts, resolve each conflict against the upstream pull request and fork/README.md, verify, and open the sync pull request on 1001-ai/1001-code. Use when asked to sync, update from, pull in, or merge upstream.
---

# Sync upstream

Read [fork/README.md](../../../fork/README.md) first. It explains why a sync is not a plain `git merge`, and it lists every place this fork differs from upstream with what has to survive a conflict.

A sync succeeds when the fork has all of upstream's new behavior and still has all of its own. One that merges cleanly but quietly drops either has failed.

## 1. Start

Work in your own worktree on a new branch from `origin/main`. Never sync in a checkout someone is using, and never on `main`.

```sh
git fetch origin main
git worktree add ../1001-code-sync -b sync/upstream-$(date +%Y%m%d) origin/main
cd ../1001-code-sync            # run `vp i` if .t3/setup-done is missing
node scripts/sync-upstream.ts status
```

`status` changes nothing. It says how many upstream commits are waiting, whether they merge cleanly, which commit conflicts first, and which upstream commits touch files the fork has changed. If nothing is waiting, say so and stop. If a sync pull request is already open on `1001-ai/1001-code`, finish or close that one first: two open syncs disagree about the pointer.

To stop short of upstream's tip, for example at a release tag, pass `--to <commit>` to the first `merge`.

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
   - A generated or binary file (`pnpm-lock.yaml`, `*.gen.ts`, icons): never merge it by hand. Take upstream's with `git checkout --theirs -- <file>`, then regenerate: `vp i` for the lockfile, the file's generator for generated code, `assets/README.md` for icons.
4. `git add` the file.

Then run `merge` again. It commits the resolution and carries on to the next conflict or the end.

Never resolve with `-X ours`, `-X theirs`, `git checkout --ours .`, or by dropping a side you did not understand. If one conflict cannot keep both intentions, stop with the merge open and tell the human what upstream did, what the fork needs, and the options. `node scripts/sync-upstream.ts abort` puts the branch back where it started.

## 3. Verify

CI does not run on this fork, so the checks run here.

```sh
vp i
vp run check:changed origin/main
```

Then:

- Run the **Check** of every divergence in `fork/README.md`.
- For every commit under "Upstream commits that touch files the fork has changed" in `status`, read the upstream change and confirm the fork's change still does its job. These merged without a conflict, and that proves nothing.

Fix what the sync broke in ordinary commits on the sync branch, one per problem, with normal messages. If a fix is large or changes what a fork feature does, stop and report instead.

## 4. Finish and open the pull request

```sh
node scripts/sync-upstream.ts finish
git push -u origin HEAD
gh pr create -R 1001-ai/1001-code --base main --title "<the title finish printed>" --body-file <the report path finish printed>
```

- **Always pass `-R 1001-ai/1001-code`.** Plain `gh` here targets upstream, and a sync must never become a pull request against `pingdotgg/t3code`.
- Before opening it, edit the report: under each resolution say in a sentence or two what you kept from each side, and add a `## Verification` section with the commands you ran and their results.
- The pull request has one commit. It lands by squash merge like any other; leave merging to the human unless you were told to merge.
- If `main` moved while you worked and the pull request conflicts, start over from the new `main`. A sync is cheap to redo and wrong to patch.

Remove the worktree when the pull request is open: `git worktree remove ../1001-code-sync`.
