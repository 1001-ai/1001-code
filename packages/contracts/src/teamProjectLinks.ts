import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import {
  TeamCatalogLink,
  type TeamCatalogLinkAccess,
  type TeamCatalogProject,
  TeamCatalogProjectKey,
} from "./teamCatalog.ts";

/**
 * `pending` is a write link the other project does not declare back yet. `no-access` is a read
 * link to a repository this environment's credentials cannot reach.
 */
export type TeamProjectLinkStatus = "active" | "pending" | "no-access";

export interface TeamProjectLink {
  readonly from: string;
  readonly to: string;
  readonly access: TeamCatalogLinkAccess;
  readonly status: TeamProjectLinkStatus;
}

export type TeamCatalogIssue =
  | {
      readonly kind: "unknown-project";
      readonly project: string;
      readonly target: string;
      readonly via: "parent" | "link";
    }
  | { readonly kind: "self-link"; readonly project: string }
  | { readonly kind: "duplicate-link"; readonly project: string; readonly target: string }
  | { readonly kind: "parent-cycle"; readonly projects: ReadonlyArray<string> };

export interface TeamProjectGraph {
  /** Every declared link that names another known project, first declaration only. */
  readonly links: ReadonlyArray<TeamProjectLink>;
  readonly issues: ReadonlyArray<TeamCatalogIssue>;
}

type ProjectLinks = Pick<TeamCatalogProject, "key" | "parent" | "links">;

function declaresWrite(project: ProjectLinks | undefined, target: string): boolean {
  return (project?.links ?? []).some((link) => link.project === target && link.access === "write");
}

function parentCycles(projects: ReadonlyArray<ProjectLinks>): ReadonlyArray<ReadonlyArray<string>> {
  const parentOf = new Map(projects.map((project) => [project.key, project.parent]));
  const cycles = new Map<string, ReadonlyArray<string>>();
  for (const project of projects) {
    const path: Array<string> = [];
    let current: string | undefined = project.key;
    while (current !== undefined && parentOf.has(current)) {
      const seenAt = path.indexOf(current);
      if (seenAt !== -1) {
        const cycle = path.slice(seenAt).sort();
        cycles.set(cycle.join("\u0000"), cycle);
        break;
      }
      path.push(current);
      current = parentOf.get(current);
    }
  }
  return [...cycles.values()];
}

/**
 * Resolves a catalog's links and finds its mistakes. `reachable` answers whether this
 * environment can reach a project's repository: false marks read links `no-access`, null means
 * not known.
 */
export function resolveTeamProjectGraph(
  projects: ReadonlyArray<ProjectLinks>,
  reachable: (key: string) => boolean | null = () => null,
): TeamProjectGraph {
  const byKey = new Map(projects.map((project) => [project.key, project]));
  const links: Array<TeamProjectLink> = [];
  const issues: Array<TeamCatalogIssue> = [];
  for (const project of projects) {
    if (project.parent !== undefined && !byKey.has(project.parent)) {
      issues.push({
        kind: "unknown-project",
        project: project.key,
        target: project.parent,
        via: "parent",
      });
    }
    const seen = new Set<string>();
    for (const link of project.links ?? []) {
      if (link.project === project.key) {
        issues.push({ kind: "self-link", project: project.key });
        continue;
      }
      if (seen.has(link.project)) {
        issues.push({ kind: "duplicate-link", project: project.key, target: link.project });
        continue;
      }
      seen.add(link.project);
      if (!byKey.has(link.project)) {
        issues.push({
          kind: "unknown-project",
          project: project.key,
          target: link.project,
          via: "link",
        });
        continue;
      }
      const status: TeamProjectLinkStatus =
        link.access === "write"
          ? declaresWrite(byKey.get(link.project), project.key)
            ? "active"
            : "pending"
          : reachable(link.project) === false
            ? "no-access"
            : "active";
      links.push({ from: project.key, to: link.project, access: link.access, status });
    }
  }
  for (const cycle of parentCycles(projects))
    issues.push({ kind: "parent-cycle", projects: cycle });
  return { links, issues };
}

export function describeTeamCatalogIssue(issue: TeamCatalogIssue): string {
  switch (issue.kind) {
    case "unknown-project":
      return issue.via === "parent"
        ? `${issue.project}'s parent "${issue.target}" is not in the catalog.`
        : `${issue.project} links to "${issue.target}", which is not in the catalog.`;
    case "self-link":
      return `${issue.project} links to itself.`;
    case "duplicate-link":
      return `${issue.project} links to ${issue.target} more than once.`;
    case "parent-cycle":
      return issue.projects.length === 1
        ? `${issue.projects[0]} is its own parent.`
        : `Parents form a loop: ${issue.projects.join(", ")}.`;
  }
}

/** GitHub logins compare case-insensitively. */
export function isTeamProjectOwner(
  project: Pick<TeamCatalogProject, "owners">,
  login: string | null,
): boolean {
  if (login === null) return false;
  const wanted = login.toLowerCase();
  return project.owners.some((owner) => owner.toLowerCase() === wanted);
}

/** The parent and links a proposal gives one project; everything else in its file stays. */
export const TeamCatalogProjectChange = Schema.Struct({
  key: TeamCatalogProjectKey,
  parent: Schema.NullOr(TeamCatalogProjectKey),
  links: Schema.Array(TeamCatalogLink).check(Schema.isMaxLength(200)),
});
export type TeamCatalogProjectChange = typeof TeamCatalogProjectChange.Type;

export const TeamCatalogProposeInput = Schema.Struct({
  /** The catalog revision the change was made against; a newer fetch must be reviewed first. */
  baseRevision: TrimmedNonEmptyString,
  changes: Schema.Array(TeamCatalogProjectChange).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(50),
  ),
});
export type TeamCatalogProposeInput = typeof TeamCatalogProposeInput.Type;

export const TeamCatalogProposal = Schema.Struct({
  branch: TrimmedNonEmptyString,
  commit: TrimmedNonEmptyString,
  /** The catalog remote the branch was pushed to. */
  remote: TrimmedNonEmptyString,
  files: Schema.Array(TrimmedNonEmptyString),
  pullRequestUrl: Schema.NullOr(TrimmedNonEmptyString),
  /** Why no pull request was opened, when the branch was pushed but one could not be. */
  pullRequestProblem: Schema.NullOr(Schema.String),
});
export type TeamCatalogProposal = typeof TeamCatalogProposal.Type;

export function applyTeamProjectChanges(
  projects: ReadonlyArray<TeamCatalogProject>,
  changes: ReadonlyArray<TeamCatalogProjectChange>,
): ReadonlyArray<TeamCatalogProject> {
  const changeByKey = new Map(changes.map((change) => [change.key, change]));
  return projects.map((project) => {
    const change = changeByKey.get(project.key);
    if (change === undefined) return project;
    const { parent: _parent, links: _links, ...rest } = project;
    return {
      ...rest,
      ...(change.parent === null ? {} : { parent: change.parent }),
      ...(change.links.length === 0 ? {} : { links: [...change.links] }),
    };
  });
}

/**
 * The changes that make each new write link in `change` mutual: the other project declares a
 * write link back, turning a read link it already has into one. Its own owners still approve.
 */
export function matchingWriteChanges(
  projects: ReadonlyArray<TeamCatalogProject>,
  change: TeamCatalogProjectChange,
): ReadonlyArray<TeamCatalogProjectChange> {
  const byKey = new Map(projects.map((project) => [project.key, project]));
  return change.links.flatMap((link) => {
    const other = byKey.get(link.project);
    if (link.access !== "write" || other === undefined || link.project === change.key) return [];
    if (declaresWrite(other, change.key)) return [];
    const links = other.links ?? [];
    const hasLink = links.some((candidate) => candidate.project === change.key);
    return [
      {
        key: other.key,
        parent: other.parent ?? null,
        links: hasLink
          ? links.map((candidate) =>
              candidate.project === change.key
                ? { ...candidate, access: "write" as const }
                : candidate,
            )
          : [...links, { project: change.key, access: "write" as const }],
      },
    ];
  });
}

function sameChange(project: TeamCatalogProject, change: TeamCatalogProjectChange): boolean {
  const links = project.links ?? [];
  return (
    (project.parent ?? null) === change.parent &&
    links.length === change.links.length &&
    links.every(
      (link, index) =>
        link.project === change.links[index]?.project &&
        link.access === change.links[index]?.access,
    )
  );
}

/**
 * Whether `login` may propose `changes`. An owner may change their project's parent and links.
 * Anyone proposing a write link may also propose the other project's matching declaration,
 * which that project's owners approve in review; nothing else on a project they do not own.
 */
function mayChange(
  byKey: ReadonlyMap<string, TeamCatalogProject>,
  changeByKey: ReadonlyMap<string, TeamCatalogProjectChange>,
  change: TeamCatalogProjectChange,
  login: string,
): boolean {
  const project = byKey.get(change.key)!;
  if (isTeamProjectOwner(project, login)) return true;
  if ((project.parent ?? null) !== change.parent) return false;
  const before = new Map((project.links ?? []).map((link) => [link.project, link.access]));
  const after = new Map(change.links.map((link) => [link.project, link.access]));
  const mirrorsOwnedWrite = (target: string) => {
    const source = byKey.get(target);
    const sourceChange = changeByKey.get(target);
    return (
      source !== undefined &&
      sourceChange !== undefined &&
      isTeamProjectOwner(source, login) &&
      sourceChange.links.some((link) => link.project === change.key && link.access === "write")
    );
  };
  for (const [target, access] of before) {
    if (after.get(target) === access) continue;
    if (!(access === "read" && after.get(target) === "write" && mirrorsOwnedWrite(target))) {
      return false;
    }
  }
  for (const [target, access] of after) {
    if (before.has(target)) continue;
    if (access !== "write" || !mirrorsOwnedWrite(target)) return false;
  }
  return true;
}

const issueId = (issue: TeamCatalogIssue) => JSON.stringify(issue);

/** Why a proposal cannot be opened, or null when it can. */
export function checkTeamCatalogProposal(
  projects: ReadonlyArray<TeamCatalogProject>,
  changes: ReadonlyArray<TeamCatalogProjectChange>,
  login: string | null,
): string | null {
  if (login === null) return "Sign in to the GitHub CLI (gh auth login) to propose changes.";
  const byKey = new Map(projects.map((project) => [project.key, project]));
  const changeByKey = new Map<string, TeamCatalogProjectChange>();
  for (const change of changes) {
    if (!byKey.has(change.key)) return `"${change.key}" is not in the catalog.`;
    if (changeByKey.has(change.key)) return `${change.key} is changed more than once.`;
    changeByKey.set(change.key, change);
  }
  if (changes.every((change) => sameChange(byKey.get(change.key)!, change))) {
    return "Nothing changed.";
  }
  for (const change of changes) {
    if (!mayChange(byKey, changeByKey, change, login)) {
      return `Only the owners of ${change.key} can change its parent and links.`;
    }
  }
  const before = new Set(resolveTeamProjectGraph(projects).issues.map(issueId));
  const introduced = resolveTeamProjectGraph(
    applyTeamProjectChanges(projects, changes),
  ).issues.find((issue) => !before.has(issueId(issue)));
  return introduced === undefined ? null : describeTeamCatalogIssue(introduced);
}

/** One line per change, as the commit and pull request describe it. */
export function describeTeamProjectChange(
  project: TeamCatalogProject,
  change: TeamCatalogProjectChange,
): ReadonlyArray<string> {
  const lines: Array<string> = [];
  if ((project.parent ?? null) !== change.parent) {
    lines.push(change.parent === null ? "no parent" : `parent ${change.parent}`);
  }
  const before = new Map((project.links ?? []).map((link) => [link.project, link.access]));
  const after = new Map(change.links.map((link) => [link.project, link.access]));
  for (const [target, access] of after) {
    const previous = before.get(target);
    if (previous === access) continue;
    lines.push(access === "write" ? `writes ${target}` : `reads ${target}`);
  }
  for (const target of before.keys()) {
    if (!after.has(target)) lines.push(`unlinks ${target}`);
  }
  return lines;
}
