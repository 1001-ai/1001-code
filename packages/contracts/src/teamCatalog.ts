import * as Schema from "effect/Schema";

import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";
import type { RepositoryIdentity } from "./environment.ts";

/**
 * A team project catalog is a git repository with one `projects/<key>.json` file per project.
 * Each environment fetches it with its own git credentials.
 */
export const TEAM_CATALOG_PROJECTS_DIRECTORY = "projects";

export const TeamCatalogProjectKey = Schema.String.check(
  Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,63}$/),
);
export type TeamCatalogProjectKey = typeof TeamCatalogProjectKey.Type;

/** `host/owner/repo` with no scheme, as in `github.com/owner/repo`. */
export const TeamCatalogRepository = Schema.String.check(
  Schema.isMaxLength(300),
  Schema.isPattern(/^[A-Za-z0-9.-]+(?::\d+)?(?:\/(?!\.{1,2}(?:\/|$))[A-Za-z0-9._~-]+){2,}$/),
);

export const TeamCatalogOwner = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/),
);

export const TeamCatalogLinkAccess = Schema.Literals(["read", "write"]);
export type TeamCatalogLinkAccess = typeof TeamCatalogLinkAccess.Type;

/** A write link counts only when both projects declare it; agents then open pull requests, never push. */
export const TeamCatalogLink = Schema.Struct({
  project: TeamCatalogProjectKey,
  access: TeamCatalogLinkAccess,
});
export type TeamCatalogLink = typeof TeamCatalogLink.Type;

/** The Linear team whose workflow states and issues are the project's board, by its key. */
export const TeamCatalogLinear = Schema.Struct({
  team: Schema.String.check(Schema.isPattern(/^[A-Z][A-Z0-9_]{0,15}$/)),
  /** Narrows the board to one Linear project in the team: its name or URL slug id. */
  project: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(200))),
});
export type TeamCatalogLinear = typeof TeamCatalogLinear.Type;

export const TeamCatalogProject = Schema.Struct({
  key: TeamCatalogProjectKey,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(100)),
  repo: TeamCatalogRepository,
  owners: Schema.Array(TeamCatalogOwner),
  parent: Schema.optionalKey(TeamCatalogProjectKey),
  links: Schema.optionalKey(Schema.Array(TeamCatalogLink)),
  linear: Schema.optionalKey(TeamCatalogLinear),
});
export type TeamCatalogProject = typeof TeamCatalogProject.Type;

export const TeamCatalogCheckoutState = Schema.Literals(["missing", "present", "occupied"]);
export type TeamCatalogCheckoutState = typeof TeamCatalogCheckoutState.Type;

/** Where adding the project puts it on this environment, and what is there now. */
export const TeamCatalogCheckout = Schema.Struct({
  path: TrimmedNonEmptyString,
  state: TeamCatalogCheckoutState,
});
export type TeamCatalogCheckout = typeof TeamCatalogCheckout.Type;

export const TeamCatalogEntry = Schema.Struct({
  file: TrimmedNonEmptyString,
  project: TeamCatalogProject,
  cloneUrl: TrimmedNonEmptyString,
  checkout: TeamCatalogCheckout,
  /** Whether this environment's credentials reach the repository; null until checked. */
  reachable: Schema.NullOr(Schema.Boolean),
});
export type TeamCatalogEntry = typeof TeamCatalogEntry.Type;

export const TeamCatalogInvalidFile = Schema.Struct({
  file: TrimmedNonEmptyString,
  reason: Schema.String,
});
export type TeamCatalogInvalidFile = typeof TeamCatalogInvalidFile.Type;

/** Who edits on this environment: the GitHub CLI's signed-in login, matched against `owners`. */
export const TeamCatalogViewer = Schema.Struct({
  login: Schema.NullOr(TeamCatalogOwner),
  /** Why there is no login, such as the GitHub CLI being signed out. */
  problem: Schema.NullOr(Schema.String),
});
export type TeamCatalogViewer = typeof TeamCatalogViewer.Type;

export const TeamCatalogSnapshot = Schema.Struct({
  /** The catalog's git URL; null when none is set. */
  source: Schema.NullOr(TrimmedNonEmptyString),
  revision: Schema.NullOr(TrimmedNonEmptyString),
  fetchedAt: Schema.NullOr(IsoDateTime),
  refreshing: Schema.Boolean,
  /** The last fetch's failure. Projects stay those of the last good fetch. */
  error: Schema.NullOr(Schema.String),
  projects: Schema.Array(TeamCatalogEntry),
  invalid: Schema.Array(TeamCatalogInvalidFile),
  viewer: TeamCatalogViewer,
});
export type TeamCatalogSnapshot = typeof TeamCatalogSnapshot.Type;

export const TeamCatalogSubscribeInput = Schema.Struct({});

export const TeamCatalogRefreshInput = Schema.Struct({
  /** Fetch even when the last fetch is recent. */
  force: Schema.optionalKey(Schema.Boolean),
});
export type TeamCatalogRefreshInput = typeof TeamCatalogRefreshInput.Type;

export const TeamCatalogSetSourceInput = Schema.Struct({
  source: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(2000))),
});
export type TeamCatalogSetSourceInput = typeof TeamCatalogSetSourceInput.Type;

export class TeamCatalogError extends Schema.TaggedError<TeamCatalogError>()("TeamCatalogError", {
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}

/** A git URL git can fetch without running anything: https, ssh, git, file, scp-like or a path. */
export function isTeamCatalogSource(source: string): boolean {
  if (/\s/.test(source) || source.startsWith("-")) return false;
  if (/^(?:https?|ssh|git|file):\/\/\S+$/i.test(source)) return true;
  if (/^[a-z][a-z0-9+.-]*::/i.test(source) || /^[a-z][a-z0-9+.-]*:\/\//i.test(source)) {
    return false;
  }
  return source.startsWith("/") || /^[^@/:]+@[^/:]+:\S+$/.test(source);
}

/** The repository as repository identities key it: lowercase, no port, trailing `/` or `.git`. */
export function teamCatalogRepositoryKey(repo: string): string {
  const key = repo.trim().toLowerCase();
  let end = key.length;
  while (end > 0 && key[end - 1] === "/") end -= 1;
  const trimmed = key.slice(0, end);
  const withoutGit = trimmed.endsWith(".git") ? trimmed.slice(0, -".git".length) : trimmed;
  // Repository identities key a remote by host without its port, so `host:2222/a/b` is `host/a/b`.
  const slash = withoutGit.indexOf("/");
  const host = slash === -1 ? withoutGit : withoutGit.slice(0, slash);
  const colon = host.indexOf(":");
  return colon === -1 ? withoutGit : `${host.slice(0, colon)}${withoutGit.slice(host.length)}`;
}

export function teamCatalogRepositoryMatches(
  repo: string,
  identity: RepositoryIdentity | null | undefined,
): boolean {
  if (!identity) return false;
  const key = teamCatalogRepositoryKey(repo);
  return (
    teamCatalogRepositoryKey(identity.canonicalKey) === key ||
    (identity.origin !== undefined &&
      teamCatalogRepositoryKey(identity.origin.canonicalKey) === key)
  );
}

export interface TeamCatalogLocalMatch<P> {
  readonly entry: TeamCatalogEntry;
  /** A project on the environment with this repository; an unarchived one when there is one. */
  readonly localProject: P | null;
}

/** Pairs catalog projects with the environment's projects by repository remote, never by path. */
export function matchTeamCatalogProjects<
  P extends {
    readonly repositoryIdentity?: RepositoryIdentity | null | undefined;
    readonly archivedAt?: string | null | undefined;
  },
>(
  entries: ReadonlyArray<TeamCatalogEntry>,
  projects: ReadonlyArray<P>,
): ReadonlyArray<TeamCatalogLocalMatch<P>> {
  return entries.map((entry) => {
    const matches = projects.filter((project) =>
      teamCatalogRepositoryMatches(entry.project.repo, project.repositoryIdentity),
    );
    return {
      entry,
      localProject: matches.find((project) => !project.archivedAt) ?? matches[0] ?? null,
    };
  });
}
