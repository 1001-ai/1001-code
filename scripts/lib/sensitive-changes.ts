/** A file upstream changed. `before` and `after` are its contents when `needsContent` asks for them. */
export interface ChangedFile {
  readonly path: string;
  readonly before?: string | undefined;
  readonly after?: string | undefined;
}

export interface SensitiveGroup {
  readonly reason: string;
  readonly items: ReadonlyArray<string>;
}

const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const VENDORED = /^\.repos\//;
// Tests and docs never ship, so the code rules skip them.
const NOT_SHIPPED = /(\.|\/)(test|tests|spec|testkit|__tests__|fixtures)(\.|\/)|^docs\/|\.mdx?$/;

const LOCKFILE = /(^|\/)pnpm-lock\.yaml$/;
const WORKSPACE = /(^|\/)pnpm-workspace\.yaml$/;
const PACKAGE_JSON = /(^|\/)package\.json$/;

/** Whether `sensitiveChanges` reads this file's contents rather than only its path. */
export const needsContent = (path: string) =>
  !VENDORED.test(path) && [LOCKFILE, WORKSPACE, PACKAGE_JSON].some((rule) => rule.test(path));

// Install-time code and the age gate on new package versions.
const WORKSPACE_KEYS = new Set([
  "allowBuilds",
  "onlyBuiltDependencies",
  "onlyBuiltDependenciesFile",
  "neverBuiltDependencies",
  "ignoredBuiltDependencies",
  "dangerouslyAllowAllBuilds",
  "strictDepBuilds",
  "minimumReleaseAge",
  "minimumReleaseAgeExclude",
]);

// npm and pnpm run these without being asked, on install, pack or publish.
const LIFECYCLE_SCRIPTS = new Set([
  "preinstall",
  "install",
  "postinstall",
  "preprepare",
  "prepare",
  "postprepare",
  "prepublish",
  "prepublishOnly",
  "prepack",
  "postpack",
  "publish",
  "postpublish",
  "dependencies",
]);

/** Path-only rules, in report order. Vendored references under `.repos/` never run, but agents read them. */
const PATH_RULES: ReadonlyArray<{
  readonly reason: string;
  readonly vendored?: boolean;
  readonly test: (path: string) => boolean;
}> = [
  {
    reason: "CI workflows and actions",
    test: (path) => /^\.github\/(workflows|actions)\//.test(path),
  },
  {
    reason: "Agent instructions (these steer our agents)",
    vendored: true,
    test: (path) =>
      /^(AGENTS|CLAUDE)\.md$/.test(basename(path)) || /^(\.agents|\.claude|evals)\//.test(path),
  },
  {
    reason: "Install and setup scripts, and git hooks",
    test: (path) =>
      /^(scripts\/setup-worktree\.ts|t3\.json|\.pnpmfile\.cjs)$/.test(path) ||
      /^(\.npmrc|install\.(sh|ps1))$/.test(basename(path)) ||
      /^(\.vite-hooks|\.husky|\.githooks)\//.test(path),
  },
  {
    reason: "Dockerfiles and dev containers",
    test: (path) =>
      /^(Dockerfile(\..+)?|.+\.dockerfile|\.dockerignore|(docker-)?compose(\.[\w-]+)?\.ya?ml)$/i.test(
        basename(path),
      ) || /^\.devcontainer\//.test(path),
  },
  {
    reason: "Update and release URLs",
    test: (path) =>
      !NOT_SHIPPED.test(path) &&
      (/^packages\/shared\/src\/(cliRelease|releaseResource)\.ts$/.test(path) ||
        /^apps\/desktop\/src\/(updates\/|electron\/ElectronUpdater\.ts$)/.test(path) ||
        /^apps\/server\/src\/(desktopUpdate\/|cli\/update\.ts$|cloud\/(npmRelease|selfUpdate|updateHandoff)\.ts$)/.test(
          path,
        )),
  },
  {
    reason: "Telemetry endpoints",
    test: (path) =>
      !NOT_SHIPPED.test(path) &&
      /(telemetry|observability|analytics|otlp|posthog|sentry)/i.test(path),
  },
  {
    reason: "Auth, policy and secrets code",
    test: (path) =>
      !NOT_SHIPPED.test(path) &&
      (/(^|\/)(auth|policy|secrets|permissions)\//.test(path) ||
        /(auth(?!or)|secret|credential|polic(y|ies)|scopes)/i.test(basename(path))),
  },
];

function lockfilePackages(text: string | undefined): Set<string> {
  const keys = new Set<string>();
  let inPackages = false;
  for (const line of (text ?? "").split("\n")) {
    if (/^\S/.test(line)) {
      inPackages = /^packages:\s*$/.test(line);
      continue;
    }
    const key = inPackages ? /^ {2}(?! )(['"]?)(.+?)\1:\s*$/.exec(line)?.[2] : undefined;
    if (key !== undefined) keys.add(key);
  }
  return keys;
}

/** Top-level YAML blocks by key, without comments, compared as lines. */
function yamlBlocks(text: string | undefined): Map<string, ReadonlyArray<string>> {
  const blocks = new Map<string, Array<string>>();
  let current: Array<string> | undefined;
  for (const raw of (text ?? "").split("\n")) {
    const line = raw.replace(/\s+#.*$|^\s*#.*$/, "").trimEnd();
    if (line === "") continue;
    const top = /^([\w-]+):(.*)$/.exec(line);
    if (top) {
      current = [];
      blocks.set(top[1]!, current);
      if (top[2]!.trim() !== "") current.push(top[2]!.trim());
    } else if (/^\s/.test(line)) {
      current?.push(line.trim());
    } else {
      current = undefined;
    }
  }
  return blocks;
}

function parseJson(text: string | undefined): Record<string, unknown> | undefined {
  if (text === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  } catch {
    return undefined;
  }
}

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};

function packageJsonItems(file: ChangedFile): ReadonlyArray<string> {
  const before = parseJson(file.before) ?? {};
  const after = parseJson(file.after);
  if (file.after !== undefined && after === undefined) {
    return [`\`${file.path}\`: no longer parses as JSON`];
  }
  const items: Array<string> = [];
  const [oldScripts, newScripts] = [record(before["scripts"]), record(after?.["scripts"])];
  const names = [...new Set([...Object.keys(oldScripts), ...Object.keys(newScripts)])].toSorted();
  for (const name of names) {
    if (oldScripts[name] === newScripts[name]) continue;
    const change =
      oldScripts[name] === undefined
        ? "added"
        : newScripts[name] === undefined
          ? "removed"
          : "changed";
    const hook = LIFECYCLE_SCRIPTS.has(name) ? " (lifecycle hook: runs on install or publish)" : "";
    items.push(`\`${file.path}\`: script \`${name}\` ${change}${hook}`);
  }
  if (JSON.stringify(before["bin"]) !== JSON.stringify(after?.["bin"])) {
    items.push(`\`${file.path}\`: \`bin\` changed`);
  }
  return items;
}

function workspaceItems(file: ChangedFile): ReadonlyArray<string> {
  const [before, after] = [yamlBlocks(file.before), yamlBlocks(file.after)];
  const items: Array<string> = [];
  for (const key of WORKSPACE_KEYS) {
    const [old, next] = [before.get(key) ?? [], after.get(key) ?? []];
    const lines = [
      ...next.filter((line) => !old.includes(line)).map((line) => `+ ${line}`),
      ...old.filter((line) => !next.includes(line)).map((line) => `- ${line}`),
    ];
    if (lines.length === 0 && before.has(key) === after.has(key)) continue;
    const shown = lines.length > 0 ? lines : [before.has(key) ? "removed" : "added"];
    items.push(`\`${file.path}\` \`${key}\`: ${shown.map((line) => `\`${line}\``).join(", ")}`);
  }
  return items;
}

/**
 * Upstream changes that deserve a human's eye before merging, grouped by why: code that runs on
 * install or in CI, text that steers agents, and code that decides where data goes or who gets in.
 */
export function sensitiveChanges(files: ReadonlyArray<ChangedFile>): ReadonlyArray<SensitiveGroup> {
  const groups = new Map<string, Array<string>>();
  const add = (reason: string, items: ReadonlyArray<string>) => {
    if (items.length === 0) return;
    groups.set(reason, [...(groups.get(reason) ?? []), ...items]);
  };
  const sorted = [...files].toSorted((left, right) => left.path.localeCompare(right.path));
  for (const file of sorted) {
    if (VENDORED.test(file.path)) continue;
    if (LOCKFILE.test(file.path)) {
      const known = lockfilePackages(file.before);
      add(
        "Packages added to pnpm-lock.yaml",
        [...lockfilePackages(file.after)]
          .filter((key) => !known.has(key))
          .map((key) => `\`${key}\``),
      );
    }
    if (WORKSPACE.test(file.path)) {
      add(
        "Build permissions and release-age settings in pnpm-workspace.yaml",
        workspaceItems(file),
      );
    }
    if (PACKAGE_JSON.test(file.path)) {
      add("package.json scripts, bin and lifecycle hooks", packageJsonItems(file));
    }
  }
  for (const rule of PATH_RULES) {
    add(
      rule.reason,
      sorted
        .filter((file) => (rule.vendored || !VENDORED.test(file.path)) && rule.test(file.path))
        .map((file) => `\`${file.path}\``),
    );
  }
  return [...groups].map(([reason, items]) => ({ reason, items }));
}
