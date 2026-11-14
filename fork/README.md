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

When an agent needs the user to decide something, it asks with the [ask-the-user skill](../.agents/skills/ask-the-user/SKILL.md), which the web and desktop clients render as answer controls.

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

### Status line under the composer

- **Where:** fork-only files hold the feature: `apps/web/src/components/chat/ComposerStatusStrip.tsx`, `chat/composerStatusStrip.logic.ts`, `apps/web/src/state/threadCost.ts`, `apps/server/src/usage/ThreadCost.ts`, `usage/threadCostEstimate.ts` and `packages/contracts/src/threadCost.ts`. Upstream files carry only the hooks:
  - `apps/web/src/components/ChatView.tsx`: the import and one `<ComposerStatusStrip>` right after `</ComposerSurface.Shell>`. The strip positions itself out of flow in the spacer under the composer, so it never moves the composer.
  - `apps/web/src/components/chat/threadDetailsItems.ts`: the `composerStatus` row in `THREAD_DETAILS_ITEMS`. It is the on/off switch, stored in the existing `threadDetailsItems` record, so no settings schema changes, and it shows up in Settings → Appearance → Thread details and the card's menu. That list's description and settings search terms still speak only of the card; they are left alone to save upstream lines.
  - `packages/contracts/src/rpc.ts` (`serverGetThreadCost` in `WS_METHODS`, its `Rpc.make`, the group entry, one import) and `packages/contracts/src/index.ts` (one export of `./threadCost.ts`).
  - `apps/server/src/ws.ts` (import, service, handler), `apps/server/src/server.ts` (import, and `ThreadCost.layer` beside `ReplayMarkers.layer`), `apps/server/src/ws.test.ts` (import and a `ThreadCost.ThreadCost` mock), `auth/RpcAuthorization.ts` and `observability/RpcInstrumentation.ts` (one row each).
  - `apps/server/src/usage/UsageService.ts`: `readRates` on the service and its test in `UsageService.test.ts`. It returns the rate table in memory or on disk at once and refreshes it in the background, so cost uses the Usage page's table without waiting on the network.
  - `apps/server/src/provider/Drivers/antigravityUsageReader.ts`: `withRateModel` is exported, so Antigravity turns price like their history.
  - `docs/user/usage.md`: the status line paragraph, which replaced the first sentence of the card paragraph under "Track subscription limits". `docs/user/composer.md` still points to the card for context use; that is still true, so it is left alone.
- **Why:** upstream shows limits and context only in the thread details card, off by default, and has no per-thread cost. The line is on by default. Cost is priced on the server from each provider turn's `turnTokenUsage`, walking subagent child threads, because the rate table and custom prices live there and the client does not load child threads. Because the line is on by default, every server now downloads the public LiteLLM price table once a day while a thread is open; upstream did that only when someone opened Usage.
- **On conflict:** take upstream's code and put each hook back. If upstream moves the composer's JSX, keep the strip right after the composer shell inside the same `relative` wrapper. If upstream renames or reshapes `turnTokenUsage`, `ProviderTurn.model`, the rate table, `getThreadRecords` or `withRateModel`, update `threadCostEstimate.ts` and its test. If upstream adds its own cost or status line, prefer theirs and drop ours. These copies never conflict, so check them on every sync: when it touches `ThreadDetailsUsage.tsx` or `collectProviderUsageLimits`, mirror the change in `composerStatusStrip.logic.ts` (`resolveInstanceLimits`, `limitTone`, `contextTone`) and `ComposerStatusStrip.tsx` (`PACE_LABEL`, the limit and context tooltips); when it touches `LITELLM_PREFIXES` in `packages/provider-opencode/src/server/usage.ts` or alias and override precedence in `usageAggregation.ts` and `usagePricing.ts`, mirror it in `threadCostEstimate.ts`.
- **Check:** `git grep -n "ComposerStatusStrip\|serverGetThreadCost\|ThreadCost\.\(layer\|ThreadCost\)\|composerStatus\|readRates\|threadCost.ts\|Status line under composer\|export function withRateModel"` shows each hook; `vp test run src/usage/ThreadCost.test.ts` and `vp test run src/usage/UsageService.test.ts -t "without waiting"` (from `apps/server`) and `vp test run src/components/chat/composerStatusStrip.logic.test.ts` (from `apps/web`) pass.

### Web client shows the product as 1001 Code

- **Where:** `apps/web/vite.config.ts` (the `productNamePlugin` import and its entry right after `bootstrapTitlePlugin()`), `apps/web/public/manifest.webmanifest` (`name` and `short_name`). The plugin is `apps/web/vite/productName.ts`, a fork-only file.
- **Why:** the name is rewritten at build time, so upstream's source strings stay as written, its edits to them merge cleanly, and strings it adds later are renamed too. The plugin turns every "T3 Code" in the web client's source and `index.html` into "1001 Code", except the phrases in `KEPT_PHRASES`, which name something outside this build: upstream's mobile app in the stores, its repository, its GNOME extension, and the label a server gives a linked machine. Tests run on the source unchanged, so upstream's assertions keep passing. The server, the CLI and the mobile app keep upstream's name.
- **On conflict:** take upstream's files, then put back the import, the `productNamePlugin()` entry after `bootstrapTitlePlugin()` (it must come after it, because that plugin writes "T3 Code" into the `<title>`), and `"1001 Code"` in the manifest's `name` and `short_name`. When a sync brings in a new web string that names upstream's own product, service or store listing rather than this app, add the phrase to `KEPT_PHRASES`.
- **Check:** `grep -n "productNamePlugin" apps/web/vite.config.ts` shows the import and the entry after `bootstrapTitlePlugin()`; `grep -n '"1001 Code"' apps/web/public/manifest.webmanifest` shows both fields.

### Desktop app shows 1001 Code but keeps upstream's identity

- **Where:** `apps/desktop/src/app/DesktopEnvironment.ts` (`APP_BASE_NAME`), `apps/desktop/src/app/DesktopAppIdentity.ts` (the `electronApp.setName` call), `apps/desktop/src/backend/DesktopLocalEnvironmentAuth.ts` (the `clientMetadata` label), `apps/desktop/scripts/electron-launcher.mjs` (`APP_DISPLAY_NAME` and the `NSScreenCaptureUsageDescription` and `NSDocumentsFolderUsageDescription` strings), and the matching expectations in `DesktopAppIdentity.test.ts` and `DesktopPreReadyPlatform.test.ts`.
- **Why:** these are the names a person reads: window titles, the application menu, the About panel, the Linux desktop entry, the dev app bundle, macOS permission prompts, and the session label in Connections settings. `app.setName` stays pinned to `T3 Code <stage>` on purpose: it is identity, not display. It sets the User-Agent token, the logs folder and the Linux window class. The bundle id, the `t3code` URL scheme, the user-data folder and the packaged `productName` in `apps/desktop/package.json` are left alone too, so an install keeps its data and its links.
- **On conflict:** take upstream's code and put back `APP_BASE_NAME = "1001 Code"`, the label `"1001 Code Desktop"`, and the three launcher strings. If upstream changes the `setName` call, take its shape but keep the literal `T3 Code` where it uses `environment.branding.baseName`, with the comment above it. Update the two test expectations that name the display name.
- **Check:** `grep -n 'APP_BASE_NAME = "1001 Code"' apps/desktop/src/app/DesktopEnvironment.ts`, `grep -n 'setName(.T3 Code' apps/desktop/src/app/DesktopAppIdentity.ts`, `grep -n "1001 Code" apps/desktop/src/backend/DesktopLocalEnvironmentAuth.ts apps/desktop/scripts/electron-launcher.mjs` (four lines), and `vp test run apps/desktop/src/app/DesktopAppIdentity.test.ts apps/desktop/src/app/DesktopPreReadyPlatform.test.ts` passes.

### Wordmark is the 1001 mark

- **Where:** `apps/web/src/components/T3Wordmark.tsx`, the `viewBox` and the path's `d`.
- **Why:** this is the logo in the web client's sidebar, standalone pages and chat timeline. The component keeps upstream's name, so every call site merges untouched. The path is the vector trace in `assets/1001/mark.svg`.
- **On conflict:** take upstream's component and put back the `viewBox` and `d` from `assets/1001/mark.svg`. If upstream renames or replaces the component, move the mark to whatever now draws the wordmark.
- **Check:** `diff <(grep -o ' d="[^"]*"' assets/1001/mark.svg) <(grep -o ' d="[^"]*"' apps/web/src/components/T3Wordmark.tsx)` prints nothing, and `grep -n 'viewBox="0 0 453.56 177.78"' apps/web/src/components/T3Wordmark.tsx` finds the `viewBox`.

### App icons carry the 1001 mark

- **Where:** the Icon Composer layers `assets/{dev,nightly,prod}/app-icon.icon/Assets/text.svg` and `assets/dev/app-icon.icon/Assets/annotations.svg`, `assets/prod/logo.svg`, every generated PNG and ICO under `assets/dev`, `assets/nightly` and `assets/prod`, their copies in `apps/web/public` (favicons, touch icon, manifest icons), the Android artwork `apps/mobile/assets/android-*.png`, and two paragraphs plus the "1001 mark" wording in `assets/README.md`. The supplied logo and its trace are in `assets/1001/`, which is fork-only.
- **Why:** the desktop, web and mobile apps show the 1001 mark instead of T3's. The blueprint annotations measure the new mark. The PNG and ICO files were rendered without Icon Composer, so `vp run icons:check` reports them until a native export replaces them, as `assets/README.md` says.
- **On conflict:** keep ours for every binary icon. If upstream changes the artwork (a background, a variant's layers, sizes or the export script), take its other layers, keep our `text.svg`, `annotations.svg` and `logo.svg`, and regenerate per `assets/README.md`: `vp run icons:export`, `vp run icons:export:android`, and the Icon Composer macOS exports. Never take upstream's generated PNG or ICO files, which carry the T3 mark. In `assets/README.md`, take upstream's text and put back the fork paragraphs and the "1001 mark" wording.
- **Check:** `grep -L "M19.665 47.547" assets/*/app-icon.icon/Assets/text.svg assets/prod/logo.svg` prints nothing; `cmp apps/web/public/favicon.ico assets/dev/blueprint-web-favicon.ico` prints nothing; opening `assets/prod/black-macos-1024.png`, `apps/web/public/icon-512x512.png` and `apps/mobile/assets/android-icon-foreground.png` shows the 1001 mark.

### Answer controls for agent questions

- **Where:** `apps/web/src/components/ChatMarkdown.tsx` (an import, and the `blockquote` renderer, which reads `threadRef`, `isStreaming` and the markdown text, and wraps the plain `<blockquote>`, not a GitHub alert, in `MarkdownQuestionQuote` with the quote's source sliced by `node.position`), `apps/web/src/components/chat/TimelineAssistantRows.tsx` (`AssistantTimelineRow` renders `AssistantQuestionMarkdown`, which takes an `askedInItemId` prop, in place of `ChatMarkdown`, whose import goes). The rest is in fork-only files in `apps/web/src/components/chat/`: `MarkdownQuestionBlock.tsx`, `AssistantQuestionMarkdown.tsx`, `questionBlockScope.ts` and `questionBlock.logic.ts`.
- **Why:** an agent can ask the user a decision question inline, as a blockquote in its reply (`> **Q4 · prompt**` then `> - option` lines; see the ask-the-user skill), and the user answers in the message that asks, whenever they read it. The question is ordinary markdown, so it reads well in clients without the card, such as the official mobile app, where the user types `Q4: answer`. The card parses the quote's source rather than its rendered tree, so the rules are exact and ordinary quotes stay quotes. Answering only writes `<id>: answer` into the thread's draft; the card reads as answered from a later user message. Nothing is stored, so there is no server, contract or database change. The wrapper sets the asking item only where the reader can reply (`onReplyToResponse` is set), so the guest page and every other `ChatMarkdown` keep showing the quote.
- **On conflict:** take upstream's code, then wrap the `blockquote` renderer's plain return in `MarkdownQuestionQuote` again, and render `AssistantQuestionMarkdown` for the assistant message's markdown again. If upstream stops passing `node` positions or changes what `ChatMarkdownTextContext` holds, slice the quote's source from wherever the renderer can still see it. If upstream moves assistant markdown out of `AssistantTimelineRow`, wrap it where it went. If upstream changes how the draft or the quiet visible turn items are read, update `MarkdownQuestionBlock.tsx`.
- **Check:** `grep -rn "MarkdownQuestionQuote\|AssistantQuestionMarkdown" apps/web/src --include=*.tsx` shows the wrapper in `ChatMarkdown.tsx` and in `TimelineAssistantRows.tsx`; `vp test run apps/web/src/components/chat/questionBlock.logic.test.ts` passes.
