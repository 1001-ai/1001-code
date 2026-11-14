import * as Schema from "effect/Schema";

import { ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { TeamCatalogViewer } from "./teamCatalog.ts";

/**
 * Team preferences are standing instructions for agents, kept as markdown in the team catalog
 * repository: one file for the whole team, one per catalog project, and one per person.
 */
export const TEAM_PREFERENCES_DIRECTORY = "preferences";
export const TEAM_PREFERENCES_TAG = "team_preferences";
/** The block agents get, wrapper included; about 2,000 tokens. */
export const TEAM_PREFERENCES_MAX_BYTES = 8_192;

export const TeamPreferencesScope = Schema.Literals(["team", "project", "personal"]);
export type TeamPreferencesScope = typeof TeamPreferencesScope.Type;

/** `key` is the catalog project key for `project` and the GitHub login for `personal`. */
export function teamPreferencesFile(scope: TeamPreferencesScope, key: string): string {
  switch (scope) {
    case "team":
      return `${TEAM_PREFERENCES_DIRECTORY}/team.md`;
    case "project":
      return `${TEAM_PREFERENCES_DIRECTORY}/projects/${key}.md`;
    case "personal":
      return `${TEAM_PREFERENCES_DIRECTORY}/people/${key.toLowerCase()}.md`;
  }
}

export const TeamPreferencesDocument = Schema.Struct({
  scope: TeamPreferencesScope,
  /** The file in the team repository; null when this scope has none here. */
  file: Schema.NullOr(TrimmedNonEmptyString),
  /** The catalog project's name or the GitHub login; null for the team. */
  label: Schema.NullOr(Schema.String),
  /** The file's text; empty when the file does not exist yet. */
  text: Schema.String,
  /** Why the scope has no file here, such as the GitHub CLI being signed out. */
  unavailable: Schema.NullOr(Schema.String),
});
export type TeamPreferencesDocument = typeof TeamPreferencesDocument.Type;

export const TeamPreferencesView = Schema.Struct({
  /** The team catalog's git URL; null when the environment has none. */
  source: Schema.NullOr(TrimmedNonEmptyString),
  revision: Schema.NullOr(TrimmedNonEmptyString),
  refreshing: Schema.Boolean,
  /** The last catalog fetch's failure; the documents stay those of the last good fetch. */
  error: Schema.NullOr(Schema.String),
  viewer: TeamCatalogViewer,
  /** Team, then project, then personal. */
  documents: Schema.Array(TeamPreferencesDocument),
  /** Exactly what agents in this project's threads get; null when every document is empty. */
  block: Schema.NullOr(Schema.String),
  /** The documents were over the size limit, so the block leaves the end out. */
  truncated: Schema.Boolean,
});
export type TeamPreferencesView = typeof TeamPreferencesView.Type;

export const TeamPreferencesProjectInput = Schema.Struct({ projectId: ProjectId });
export type TeamPreferencesProjectInput = typeof TeamPreferencesProjectInput.Type;

export const TeamPreferencesProposeInput = Schema.Struct({
  projectId: ProjectId,
  scope: TeamPreferencesScope,
  /** The catalog revision the text was edited from. */
  baseRevision: TrimmedNonEmptyString,
  text: Schema.String.check(Schema.isMaxLength(TEAM_PREFERENCES_MAX_BYTES)),
});
export type TeamPreferencesProposeInput = typeof TeamPreferencesProposeInput.Type;

const byteLength = (text: string) => new TextEncoder().encode(text).length;

function cutToBytes(text: string, budget: number): string {
  const cut = new TextDecoder().decode(new TextEncoder().encode(text).slice(0, budget));
  // Drop a character split by the cut, then the partial line.
  const whole = cut.endsWith("�") ? cut.slice(0, -1) : cut;
  const lineEnd = whole.lastIndexOf("\n");
  return lineEnd > 0 ? whole.slice(0, lineEnd) : whole;
}

function scopeHeading(document: Pick<TeamPreferencesDocument, "scope" | "label">): string {
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
 * The `<team_preferences>` block agents get: each non-empty document, team first and personal
 * last, so the more specific one comes later and wins. Null when there is nothing to send.
 */
export function buildTeamPreferencesBlock(input: {
  readonly documents: ReadonlyArray<
    Pick<TeamPreferencesDocument, "scope" | "file" | "label" | "text">
  >;
  /** Where a change is proposed, such as `github.com/team/home`. */
  readonly repository: string | null;
}): { readonly text: string; readonly truncated: boolean } | null {
  const closing = `</${TEAM_PREFERENCES_TAG}>`;
  const sections = input.documents.flatMap((document) => {
    // A closing tag inside a file would end the block early.
    const text = document.text.replaceAll(closing, "").trim();
    return document.file === null || text === ""
      ? []
      : [`From ${document.file} (${scopeHeading(document)}):\n${text}`];
  });
  if (sections.length === 0) return null;
  const header = [
    `<${TEAM_PREFERENCES_TAG}>`,
    "Standing preferences from the team repository. Follow them unless the user says otherwise; a later section is more specific and wins over an earlier one.",
  ].join("\n");
  const footer = [
    `To add or change a preference, open a pull request that edits these files under ${TEAM_PREFERENCES_DIRECTORY}/${input.repository === null ? " in the team repository" : ` in ${input.repository}`}, or ask the user to change it in the Team preferences panel.`,
    closing,
  ].join("\n");
  const body = sections.join("\n\n");
  const whole = `${header}\n\n${body}\n\n${footer}`;
  if (byteLength(whole) <= TEAM_PREFERENCES_MAX_BYTES) return { text: whole, truncated: false };
  const notice = "(The rest was left out: these preferences are over the size limit.)";
  const budget = TEAM_PREFERENCES_MAX_BYTES - byteLength(`${header}\n\n\n${notice}\n\n${footer}`);
  return {
    text: `${header}\n\n${cutToBytes(body, budget)}\n${notice}\n\n${footer}`,
    truncated: true,
  };
}
