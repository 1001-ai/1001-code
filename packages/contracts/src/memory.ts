import * as Schema from "effect/Schema";

import { ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { TeamCatalogViewer } from "./teamCatalog.ts";

/**
 * Memory is what agents are told to follow and remember, kept as markdown in the team catalog
 * repository: one file for the whole team, one per catalog project, and one per person.
 */
export const MEMORY_DIRECTORY = "memory";
export const MEMORY_TAG = "memory";
/** The block agents get, wrapper included; about 2,000 tokens. */
export const MEMORY_MAX_BYTES = 8_192;

export const MemoryScope = Schema.Literals(["team", "project", "personal"]);
export type MemoryScope = typeof MemoryScope.Type;

/** `key` is the catalog project key for `project` and the GitHub login for `personal`. */
export function memoryFile(scope: MemoryScope, key: string): string {
  switch (scope) {
    case "team":
      return `${MEMORY_DIRECTORY}/team.md`;
    case "project":
      return `${MEMORY_DIRECTORY}/projects/${key}.md`;
    case "personal":
      return `${MEMORY_DIRECTORY}/people/${key.toLowerCase()}.md`;
  }
}

export const MemoryDocument = Schema.Struct({
  scope: MemoryScope,
  /** The file in the team repository; null when this scope has none here. */
  file: Schema.NullOr(TrimmedNonEmptyString),
  /** The catalog project's name or the GitHub login; null for the team. */
  label: Schema.NullOr(Schema.String),
  /** The file's text; empty when the file does not exist yet. */
  text: Schema.String,
  /** Why the scope has no file here, such as the GitHub CLI being signed out. */
  unavailable: Schema.NullOr(Schema.String),
});
export type MemoryDocument = typeof MemoryDocument.Type;

export const MemoryView = Schema.Struct({
  /** The team catalog's git URL; null when the environment has none. */
  source: Schema.NullOr(TrimmedNonEmptyString),
  revision: Schema.NullOr(TrimmedNonEmptyString),
  refreshing: Schema.Boolean,
  /** The last catalog fetch's failure; the documents stay those of the last good fetch. */
  error: Schema.NullOr(Schema.String),
  viewer: TeamCatalogViewer,
  /** Team, then project, then personal. */
  documents: Schema.Array(MemoryDocument),
  /** Exactly what agents in this project's threads get; null when every document is empty. */
  block: Schema.NullOr(Schema.String),
  /** The documents were over the size limit, so the block leaves the end out. */
  truncated: Schema.Boolean,
});
export type MemoryView = typeof MemoryView.Type;

export const MemoryProjectInput = Schema.Struct({ projectId: ProjectId });
export type MemoryProjectInput = typeof MemoryProjectInput.Type;

export const MemoryProposeInput = Schema.Struct({
  projectId: ProjectId,
  scope: MemoryScope,
  /** The catalog revision the text was edited from. */
  baseRevision: TrimmedNonEmptyString,
  text: Schema.String.check(Schema.isMaxLength(MEMORY_MAX_BYTES)),
});
export type MemoryProposeInput = typeof MemoryProposeInput.Type;

const byteLength = (text: string) => new TextEncoder().encode(text).length;

function cutToBytes(text: string, budget: number): string {
  const cut = new TextDecoder().decode(new TextEncoder().encode(text).slice(0, budget));
  // Drop a character split by the cut, then the partial line.
  const whole = cut.endsWith("�") ? cut.slice(0, -1) : cut;
  const lineEnd = whole.lastIndexOf("\n");
  return lineEnd > 0 ? whole.slice(0, lineEnd) : whole;
}

function scopeHeading(document: Pick<MemoryDocument, "scope" | "label">): string {
  switch (document.scope) {
    case "team":
      return "for everyone on the team";
    case "project":
      return `for the project ${document.label ?? ""}`.trimEnd();
    case "personal":
      return `for ${document.label ?? "you"} only`;
  }
}

/**
 * The `<memory>` block agents get: each non-empty document, team first and personal
 * last, so the more specific one comes later and wins. Null when there is nothing to send.
 */
export function buildMemoryBlock(input: {
  readonly documents: ReadonlyArray<Pick<MemoryDocument, "scope" | "file" | "label" | "text">>;
  /** Where a change is proposed, such as `github.com/team/home`. */
  readonly repository: string | null;
}): { readonly text: string; readonly truncated: boolean } | null {
  const closing = `</${MEMORY_TAG}>`;
  const sections = input.documents.flatMap((document) => {
    // A closing tag inside a file would end the block early.
    const text = document.text.replaceAll(closing, "").trim();
    return document.file === null || text === ""
      ? []
      : [`From ${document.file} (${scopeHeading(document)}):\n${text}`];
  });
  if (sections.length === 0) return null;
  const header = [
    `<${MEMORY_TAG}>`,
    "Memory from the team repository: standing instructions and facts. Follow it unless the user says otherwise; a later section is more specific and wins over an earlier one.",
  ].join("\n");
  const footer = [
    `To add or change a memory, open a pull request that edits these files under ${MEMORY_DIRECTORY}/${input.repository === null ? " in the team repository" : ` in ${input.repository}`}, or ask the user to change it in the Memory panel.`,
    closing,
  ].join("\n");
  const body = sections.join("\n\n");
  const whole = `${header}\n\n${body}\n\n${footer}`;
  if (byteLength(whole) <= MEMORY_MAX_BYTES) return { text: whole, truncated: false };
  const notice = "(The rest was left out: this memory is over the size limit.)";
  const budget = MEMORY_MAX_BYTES - byteLength(`${header}\n\n\n${notice}\n\n${footer}`);
  return {
    text: `${header}\n\n${cutToBytes(body, budget)}\n${notice}\n\n${footer}`,
    truncated: true,
  };
}
