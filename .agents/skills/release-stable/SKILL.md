---
name: release-stable
description: Release 1001 Code to the team by moving the `stable` tag on 1001-ai/1001-code to a commit on `main` whose CI passed, or roll a release back by moving it to an earlier one. Use when asked to release, ship, cut a build, move or bump stable, or roll back.
---

# Release

A release here is the `stable` tag. Every team install checks it every hour, and when it moves, builds the commit it names on that person's Mac with their credentials and offers "Restart to update". The Inbox and the timeline announce the move within 10 minutes. So moving `stable` deploys to everyone at once. There are no version numbers, GitHub Releases or packages. Upstream's release workflows and [docs/operations/release.md](../../../docs/operations/release.md) do not apply: they are disabled here (see [fork/README.md](../../../fork/README.md), "Only CI workflows are enabled on GitHub").

The private build has its own `stable` tag, which installs also build. Moving it follows the private build's README, not this skill.

## Rules

- Release only a commit on `main`'s history whose `CI` run passed. Never a branch, a pull request head or a local commit.
- Show the user what will ship and get a yes before you push the tag, unless they already told you to release that commit.
- Keep the tag annotated, and keep its message public-safe: no internal names, task ids or people's names. The pre-push hook checks it; reword if it blocks, never `--no-verify`.
- Roll back by moving the tag, never by deleting it. With no `stable` tag installs cannot update at all.

## 1. Check access

```sh
gh ruleset list -R 1001-ai/1001-code
gh ruleset view <id of the stable tag ruleset> -R 1001-ai/1001-code
```

The ruleset on `refs/tags/stable` must say `You can bypass: always`. If it says `never`, stop and tell the user: only the people the ruleset lets bypass can release. (Its "Bypass List" reads empty to anyone who cannot edit the ruleset; trust the `You can bypass` line.)

## 2. Pick the commit

```sh
git fetch origin main --tags --force
target=$(git rev-parse origin/main)          # or the commit the user named
git merge-base --is-ancestor "$target" origin/main && echo "on main"
old=$(git rev-parse 'stable^{}')
```

If `$target` equals `$old`, there is nothing to release; say so and stop.

## 3. Check CI

```sh
gh run list -R 1001-ai/1001-code --workflow CI --commit "$target" --json status,conclusion,url
```

It must show a completed run with conclusion `success`. If the run is still going, wait for it to finish (or offer the newest commit whose run passed). A failed or missing run means no release.

## 4. Show what ships

```sh
git log --first-parent --format='%h %s' "$old..$target"
git diff --stat "$old" "$target" -- apps/server/src/persistence/Migrations
```

Give the user the list. Point out:

- upstream syncs in the range (`Merge pull request #N from 1001-ai/sync/upstream-…`): they bring upstream's commits, already reviewed in that pull request;
- any new database migration: once installs run it, rolling back past it can leave an older build that cannot open the newer database, so a bad release after a migration is fixed forward, not rolled back.

## 5. Move the tag

Put the old commit in the message, so a rollback knows where to go:

```sh
subject=$(git log -1 --format=%s "$target")
git tag -fa stable "$target" -m "Release: $subject" -m "Previous: $old"
git push --force origin stable
```

## 6. Verify

```sh
git ls-remote --tags origin stable    # the `stable^{}` line must be $target
```

Then tell the user: installs pick it up on their next hourly check, build it, and offer "Restart to update"; the Inbox announces it within 10 minutes. A build already staged for an older `stable` is discarded on restart.

## Roll back

Move `stable` to the commit before, through the same steps 1, 3, 5 and 6. The previous commit is in the current tag's message:

```sh
git cat-file -p stable | grep '^Previous:'
```

Installs treat the move like any release and rebuild that commit. Check step 4's migration warning against the range you are undoing first. Once the problem is fixed on `main`, release again.
