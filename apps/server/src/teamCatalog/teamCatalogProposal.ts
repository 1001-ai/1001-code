import {
  describeTeamProjectChange,
  type TeamCatalogProject,
  type TeamCatalogProjectChange,
} from "@t3tools/contracts";

/** The file with the change's parent and links, every other field and its order kept. */
export function proposalFileText(original: string, change: TeamCatalogProjectChange): string {
  const value = JSON.parse(original) as Record<string, unknown>;
  if (change.parent === null) delete value.parent;
  else value.parent = change.parent;
  if (change.links.length === 0) delete value.links;
  else value.links = change.links.map((link) => ({ project: link.project, access: link.access }));
  return formatCatalogFile(value);
}

const inline = (value: unknown): string =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? `{ ${Object.entries(value)
        .map(([key, item]) => `${JSON.stringify(key)}: ${JSON.stringify(item)}`)
        .join(", ")} }`
    : JSON.stringify(value);

/**
 * The catalog's own layout: one field per line, lists of names on one line, and one line per
 * link, so a proposal's diff shows only what changed.
 */
function formatCatalogFile(value: Record<string, unknown>): string {
  const fields = Object.entries(value).map(([key, item]) => {
    const text =
      Array.isArray(item) && item.some((entry) => entry !== null && typeof entry === "object")
        ? `[\n${item.map((entry) => `    ${inline(entry)}`).join(",\n")}\n  ]`
        : Array.isArray(item)
          ? `[${item.map((entry) => JSON.stringify(entry)).join(", ")}]`
          : inline(item);
    return `  ${JSON.stringify(key)}: ${text}`;
  });
  return `{\n${fields.join(",\n")}\n}\n`;
}

export interface ProposalText {
  readonly title: string;
  readonly body: string;
  /** Names the change; the caller appends the commit so retries never collide. */
  readonly branchStem: string;
}

export function proposalText(
  projects: ReadonlyArray<TeamCatalogProject>,
  changes: ReadonlyArray<TeamCatalogProjectChange>,
): ProposalText {
  const byKey = new Map(projects.map((project) => [project.key, project]));
  const described = changes.map((change) => ({
    key: change.key,
    lines: describeTeamProjectChange(byKey.get(change.key)!, change),
  }));
  const [first] = described;
  const title =
    described.length === 1 && first !== undefined
      ? `${first.key}: ${first.lines.join(", ")}`
      : `Team projects: ${described.map((entry) => entry.key).join(", ")}`;
  const mirrored = changes.length > 1;
  const body = [
    ...described.map((entry) =>
      [`**${entry.key}**`, ...entry.lines.map((line) => `- ${line}`)].join("\n"),
    ),
    ...(mirrored
      ? [
          "A write link counts only when both projects declare it, so this also declares the other side. Each project's owners approve their own file.",
        ]
      : []),
  ].join("\n\n");
  const what = changes.some((change) => (byKey.get(change.key)?.parent ?? null) !== change.parent)
    ? "grouping"
    : "links";
  const branchStem = `team-catalog/${changes
    .map((change) => change.key)
    .join("-")
    .slice(0, 60)}-${what}`;
  return { title: title.slice(0, 200), body, branchStem };
}

const HOSTED_SOURCE = [
  /^https?:\/\/(?:[^@/\s]+@)?([^/:\s]+)(?::\d+)?\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i,
  /^ssh:\/\/(?:[^@/\s]+@)?([^/:\s]+)(?::\d+)?\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i,
  /^(?:[^@/:\s]+@)?([^/:\s]+):([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/,
];

/** `host/owner/repo` for a hosted catalog remote, or null for a path or file URL. */
export function hostedRepositoryOf(source: string): string | null {
  for (const pattern of HOSTED_SOURCE) {
    const match = pattern.exec(source);
    if (match) return `${match[1]!.toLowerCase()}/${match[2]}/${match[3]}`;
  }
  return null;
}
