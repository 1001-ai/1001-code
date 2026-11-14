import { describe, expect, it } from "vite-plus/test";

import { needsContent, sensitiveChanges, type ChangedFile } from "./sensitive-changes.ts";

const LOCK_BEFORE = `lockfileVersion: '9.0'

importers:

  .:
    dependencies:
      left-pad:
        specifier: ^1.0.0
        version: 1.3.0

packages:

  left-pad@1.3.0:
    resolution: {integrity: sha512-a}

snapshots:

  left-pad@1.3.0: {}
`;

const LOCK_AFTER = `lockfileVersion: '9.0'

importers:

  .:
    dependencies:
      left-pad:
        specifier: ^1.0.0
        version: 1.3.0
      '@evil/pkg':
        specifier: ^2.0.0
        version: 2.0.0

packages:

  '@evil/pkg@2.0.0':
    resolution: {integrity: sha512-b}

  left-pad@1.3.0:
    resolution: {integrity: sha512-a}

snapshots:

  '@evil/pkg@2.0.0': {}

  left-pad@1.3.0: {}
`;

const WORKSPACE_BEFORE = `packages:
  - apps/*

# Which packages may run install scripts.
allowBuilds:
  esbuild: true
  sharp: false

minimumReleaseAge: 1440

catalog:
  effect: 4.0.0
`;

const WORKSPACE_AFTER = `packages:
  - apps/*

allowBuilds:
  esbuild: true
  sharp: true # needs its binary
  evil: true

catalog:
  effect: 4.1.0
`;

const pkg = (value: Record<string, unknown>) => `${JSON.stringify(value, null, 2)}\n`;

describe("sensitiveChanges", () => {
  it.each<{
    readonly name: string;
    readonly files: ReadonlyArray<ChangedFile>;
    readonly expected: ReadonlyArray<readonly [string, ReadonlyArray<string>]>;
  }>([
    {
      name: "ordinary source, docs and tests",
      files: [
        { path: "apps/web/src/components/ChatView.tsx" },
        { path: "docs/operations/observability.md" },
        { path: "apps/server/src/auth/EnvironmentAuth.test.ts" },
        { path: "apps/web/src/components/CommitAuthor.tsx" },
      ],
      expected: [],
    },
    {
      name: "packages added to the lockfile",
      files: [{ path: "pnpm-lock.yaml", before: LOCK_BEFORE, after: LOCK_AFTER }],
      expected: [["Packages added to pnpm-lock.yaml", ["`@evil/pkg@2.0.0`"]]],
    },
    {
      name: "a lockfile that only drops packages",
      files: [{ path: "pnpm-lock.yaml", before: LOCK_AFTER, after: LOCK_BEFORE }],
      expected: [],
    },
    {
      name: "build permissions and release age in the workspace, not the catalog",
      files: [{ path: "pnpm-workspace.yaml", before: WORKSPACE_BEFORE, after: WORKSPACE_AFTER }],
      expected: [
        [
          "Build permissions and release-age settings in pnpm-workspace.yaml",
          [
            "`pnpm-workspace.yaml` `allowBuilds`: `+ sharp: true`, `+ evil: true`, `- sharp: false`",
            "`pnpm-workspace.yaml` `minimumReleaseAge`: `- 1440`",
          ],
        ],
      ],
    },
    {
      name: "package.json scripts, bin and lifecycle hooks, not dependencies",
      files: [
        {
          path: "apps/server/package.json",
          before: pkg({ scripts: { dev: "vite", test: "vp test" }, dependencies: { a: "1" } }),
          after: pkg({
            scripts: { dev: "vite --host", postinstall: "node setup.js" },
            bin: { t3: "dist/bin.mjs" },
            dependencies: { a: "2" },
          }),
        },
        {
          path: "packages/shared/package.json",
          before: pkg({ dependencies: { a: "1" } }),
          after: pkg({ dependencies: { a: "2" } }),
        },
      ],
      expected: [
        [
          "package.json scripts, bin and lifecycle hooks",
          [
            "`apps/server/package.json`: script `dev` changed",
            "`apps/server/package.json`: script `postinstall` added (lifecycle hook: runs on install or publish)",
            "`apps/server/package.json`: script `test` removed",
            "`apps/server/package.json`: `bin` changed",
          ],
        ],
      ],
    },
    {
      name: "a package.json that stops parsing",
      files: [{ path: "package.json", before: pkg({}), after: "{ nope" }],
      expected: [
        [
          "package.json scripts, bin and lifecycle hooks",
          ["`package.json`: no longer parses as JSON"],
        ],
      ],
    },
    {
      name: "CI workflows and actions",
      files: [
        { path: ".github/workflows/release.yml" },
        { path: ".github/actions/setup-ci-deps/action.yml" },
        { path: ".github/pull_request_template.md" },
      ],
      expected: [
        [
          "CI workflows and actions",
          ["`.github/actions/setup-ci-deps/action.yml`", "`.github/workflows/release.yml`"],
        ],
      ],
    },
    {
      name: "agent instructions, including vendored ones agents read",
      files: [
        { path: "AGENTS.md" },
        { path: "apps/web/CLAUDE.md" },
        { path: ".agents/skills/sync-upstream/SKILL.md" },
        { path: ".claude/settings.json" },
        { path: "evals/README.md" },
        { path: ".repos/effect/AGENTS.md" },
        { path: ".repos/effect/Dockerfile" },
      ],
      expected: [
        [
          "Agent instructions (these steer our agents)",
          [
            "`.agents/skills/sync-upstream/SKILL.md`",
            "`.claude/settings.json`",
            "`.repos/effect/AGENTS.md`",
            "`AGENTS.md`",
            "`apps/web/CLAUDE.md`",
            "`evals/README.md`",
          ],
        ],
      ],
    },
    {
      name: "install and setup scripts, git hooks and containers",
      files: [
        { path: "scripts/setup-worktree.ts" },
        { path: "t3.json" },
        { path: ".pnpmfile.cjs" },
        { path: "apps/web/.npmrc" },
        { path: "scripts/install.sh" },
        { path: ".vite-hooks/pre-commit" },
        { path: "infra/relay/Dockerfile" },
        { path: ".devcontainer/devcontainer.json" },
      ],
      expected: [
        [
          "Install and setup scripts, and git hooks",
          [
            "`.pnpmfile.cjs`",
            "`.vite-hooks/pre-commit`",
            "`apps/web/.npmrc`",
            "`scripts/install.sh`",
            "`scripts/setup-worktree.ts`",
            "`t3.json`",
          ],
        ],
        [
          "Dockerfiles and dev containers",
          ["`.devcontainer/devcontainer.json`", "`infra/relay/Dockerfile`"],
        ],
      ],
    },
    {
      name: "update URLs, telemetry, and auth, policy and secrets code",
      files: [
        { path: "packages/shared/src/cliRelease.ts" },
        { path: "apps/desktop/src/updates/updateChannels.ts" },
        { path: "apps/server/src/cloud/selfUpdate.ts" },
        { path: "apps/server/src/observability/Observability.ts" },
        { path: "apps/desktop/src/telemetry/DesktopTelemetryPublisher.ts" },
        { path: "apps/server/src/auth/SessionStore.ts" },
        { path: "apps/server/src/policy/ManagedPolicy.ts" },
        { path: "apps/server/src/settingsSecrets.ts" },
        { path: "apps/server/src/cli/authScopes.ts" },
      ],
      expected: [
        [
          "Update and release URLs",
          [
            "`apps/desktop/src/updates/updateChannels.ts`",
            "`apps/server/src/cloud/selfUpdate.ts`",
            "`packages/shared/src/cliRelease.ts`",
          ],
        ],
        [
          "Telemetry endpoints",
          [
            "`apps/desktop/src/telemetry/DesktopTelemetryPublisher.ts`",
            "`apps/server/src/observability/Observability.ts`",
          ],
        ],
        [
          "Auth, policy and secrets code",
          [
            "`apps/server/src/auth/SessionStore.ts`",
            "`apps/server/src/cli/authScopes.ts`",
            "`apps/server/src/policy/ManagedPolicy.ts`",
            "`apps/server/src/settingsSecrets.ts`",
          ],
        ],
      ],
    },
  ])("$name", ({ files, expected }) => {
    expect(sensitiveChanges(files).map((group) => [group.reason, group.items] as const)).toEqual(
      expected,
    );
  });

  it("reads contents only for the files whose rules need them", () => {
    expect(
      [
        "pnpm-lock.yaml",
        "pnpm-workspace.yaml",
        "apps/web/package.json",
        "AGENTS.md",
        ".repos/x/package.json",
      ].map(needsContent),
    ).toEqual([true, true, true, false, false]);
  });
});
