import {
  TeamCatalogProject,
  type TeamCatalogInvalidFile,
  teamCatalogRepositoryKey,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

export interface TeamCatalogFile {
  /** Path inside the catalog, such as `projects/web.json`. */
  readonly file: string;
  readonly text: string;
}

export interface DecodedTeamCatalogProject {
  readonly file: string;
  readonly project: TeamCatalogProject;
}

export interface DecodedTeamCatalog {
  readonly projects: ReadonlyArray<DecodedTeamCatalogProject>;
  readonly invalid: ReadonlyArray<TeamCatalogInvalidFile>;
}

const decodeProjectJson = Schema.decodeUnknownExit(Schema.fromJsonString(TeamCatalogProject), {
  onExcessProperty: "error",
});

function fileStem(file: string): string {
  return (file.split("/").at(-1) ?? file).replace(/\.json$/, "");
}

function decodeFile(file: TeamCatalogFile): TeamCatalogProject | string {
  const decoded = decodeProjectJson(file.text);
  if (Exit.isFailure(decoded)) {
    const error = Cause.squash(decoded.cause);
    return Schema.isSchemaError(error)
      ? error.message.replace(/\s*\n\s*/g, " ")
      : "Not valid JSON.";
  }
  const project = decoded.value;
  if (project.key !== fileStem(file.file)) {
    return `The key "${project.key}" does not match the file name.`;
  }
  if (project.parent === project.key) return "A project cannot be its own parent.";
  const linked = new Set<string>();
  for (const link of project.links ?? []) {
    if (link.project === project.key) return "A project cannot link to itself.";
    if (linked.has(link.project)) return `"${link.project}" is linked more than once.`;
    linked.add(link.project);
  }
  return project;
}

/**
 * Decodes every project file strictly. A bad file is reported and skipped, never fatal, and
 * a second file for a repository already listed is skipped so matching stays unambiguous.
 */
export function decodeTeamCatalogFiles(files: ReadonlyArray<TeamCatalogFile>): DecodedTeamCatalog {
  const projects: Array<DecodedTeamCatalogProject> = [];
  const invalid: Array<TeamCatalogInvalidFile> = [];
  const fileByRepository = new Map<string, string>();
  for (const file of [...files].toSorted((left, right) => left.file.localeCompare(right.file))) {
    const decoded = decodeFile(file);
    if (typeof decoded === "string") {
      invalid.push({ file: file.file, reason: decoded });
      continue;
    }
    const repository = teamCatalogRepositoryKey(decoded.repo);
    const listedBy = fileByRepository.get(repository);
    if (listedBy !== undefined) {
      invalid.push({ file: file.file, reason: `${listedBy} already lists ${decoded.repo}.` });
      continue;
    }
    fileByRepository.set(repository, file.file);
    projects.push({ file: file.file, project: decoded });
  }
  return { projects, invalid };
}

// The schema already refuses a trailing `/` in `repo`.
function repositorySegments(repo: string): ReadonlyArray<string> {
  const trimmed = repo.trim();
  return (trimmed.endsWith(".git") ? trimmed.slice(0, -".git".length) : trimmed).split("/");
}

/** The folder below the managed projects folder: `<repo>`, or `<host>/<owner>/<repo>` like ghq. */
export function teamCatalogCheckoutFolder(repo: string, ghqLayout: boolean): ReadonlyArray<string> {
  const segments = repositorySegments(repo);
  return ghqLayout ? segments.map((segment) => segment.replace(":", "_")) : [segments.at(-1)!];
}

const SSH_SOURCE = /^ssh:\/\/(?:([^@/\s]+)@)?([^/:\s]+)(?::(\d+))?\//i;
const SCP_SOURCE = /^(?:([^@/:\s]+)@)?([^/:\s]+):(?!\/)/;
const HTTPS_SOURCE = /^https?:\/\/(?:[^@/\s]+@)?([^/:\s]+)(?::(\d+))?\//i;

/**
 * Clones over the transport the catalog itself was fetched with, which this machine has proven:
 * on the catalog's host that keeps its SSH user and port too. Never copies HTTPS credentials.
 */
export function teamCatalogCloneUrl(repo: string, source: string): string {
  const [hostPart = "", ...path] = repositorySegments(repo);
  const [host = "", port] = hostPart.split(":");
  const repository = `${path.join("/")}.git`;
  const sameHost = (candidate: string | undefined) =>
    candidate !== undefined && candidate.toLowerCase() === host.toLowerCase();

  const ssh = SSH_SOURCE.exec(source);
  if (ssh) {
    if (port !== undefined) return `https://${hostPart}/${repository}`;
    if (!sameHost(ssh[2])) return `git@${host}:${repository}`;
    const user = ssh[1] === undefined ? "" : `${ssh[1]}@`;
    const sshPort = ssh[3] === undefined ? "" : `:${ssh[3]}`;
    return sshPort === ""
      ? `${user}${ssh[2]}:${repository}`
      : `ssh://${user}${ssh[2]}${sshPort}/${repository}`;
  }
  const scp = source.includes("://") ? null : SCP_SOURCE.exec(source);
  if (scp && scp[1] !== undefined) {
    if (port !== undefined) return `https://${hostPart}/${repository}`;
    return `${sameHost(scp[2]) ? scp[1] : "git"}@${host}:${repository}`;
  }
  const https = HTTPS_SOURCE.exec(source);
  if (https && sameHost(https[1]) && https[2] !== undefined && port === undefined) {
    return `https://${host}:${https[2]}/${repository}`;
  }
  return `https://${hostPart}/${repository}`;
}
