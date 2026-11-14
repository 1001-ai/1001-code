import {
  TeamCatalogProject,
  type TeamCatalogInvalidFile,
  teamCatalogRepositoryKey,
} from "@t3tools/contracts";
import { cloneUrlProtocol } from "@t3tools/shared/cloneUrl";
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

function repositorySegments(repo: string): ReadonlyArray<string> {
  return repo
    .trim()
    .replace(/\/+$/, "")
    .replace(/\.git$/, "")
    .split("/");
}

/** The folder below the managed projects folder: `<repo>`, or `<host>/<owner>/<repo>` like ghq. */
export function teamCatalogCheckoutFolder(repo: string, ghqLayout: boolean): ReadonlyArray<string> {
  const segments = repositorySegments(repo);
  return ghqLayout ? segments.map((segment) => segment.replace(":", "_")) : [segments.at(-1)!];
}

/** Clones over the transport the catalog itself was fetched with, which this machine has proven. */
export function teamCatalogCloneUrl(repo: string, source: string): string {
  const [host, ...path] = repositorySegments(repo);
  const repository = `${path.join("/")}.git`;
  return cloneUrlProtocol(source) === "ssh" && !host!.includes(":")
    ? `git@${host}:${repository}`
    : `https://${host}/${repository}`;
}
