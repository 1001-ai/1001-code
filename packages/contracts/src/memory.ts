import * as Schema from "effect/Schema";

import { IsoDateTime, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { TeamCatalogViewer } from "./teamCatalog.ts";

/**
 * Memory is what agents are told to follow and remember, kept as markdown in the team catalog
 * repository: one file for the whole team, one per catalog project, one per person, and one per
 * person in a project. Agents propose additions, changes and removals with `memory_propose`; a
 * person accepts each one.
 */
export const MEMORY_DIRECTORY = "memory";
export const MEMORY_TAG = "memory";
/** The block agents get, wrapper included; about 2,000 tokens. */
export const MEMORY_MAX_BYTES = 8_192;

export const MemoryScope = Schema.Literals(["team", "project", "personal", "personal-project"]);
export type MemoryScope = typeof MemoryScope.Type;

/** `project` is the catalog project key and `login` the GitHub login. */
export type MemoryFileTarget =
  | { readonly scope: "team" }
  | { readonly scope: "project"; readonly project: string }
  | { readonly scope: "personal"; readonly login: string }
  | { readonly scope: "personal-project"; readonly project: string; readonly login: string };

export function memoryFile(target: MemoryFileTarget): string {
  switch (target.scope) {
    case "team":
      return `${MEMORY_DIRECTORY}/team.md`;
    case "project":
      return `${MEMORY_DIRECTORY}/projects/${target.project}.md`;
    case "personal":
      return `${MEMORY_DIRECTORY}/people/${target.login.toLowerCase()}.md`;
    case "personal-project":
      return `${MEMORY_DIRECTORY}/projects/${target.project}/people/${target.login.toLowerCase()}.md`;
  }
}

/**
 * The voice agent's own category: how one person wants its spoken updates. It has one file per
 * person and is never part of the `<memory>` block, so no other agent gets it.
 */
export const VOICE_AGENT_MEMORY_CATEGORY = "voice-agent-memories";
export const VOICE_AGENT_MEMORY_TAG = "voice_agent_memories";
/** The active memories the voice agent gets, wrapper included; about 500 tokens. */
export const VOICE_AGENT_MEMORY_MAX_BYTES = 2_048;

export const MemoryCategory = Schema.Literal(VOICE_AGENT_MEMORY_CATEGORY);
export type MemoryCategory = typeof MemoryCategory.Type;

export function voiceAgentMemoryFile(login: string): string {
  return `${MEMORY_DIRECTORY}/people/${login.toLowerCase()}/${VOICE_AGENT_MEMORY_CATEGORY}.md`;
}

export const MEMORY_PROPOSE_TOOL_NAME = "memory_propose";
export const MEMORY_WITHDRAW_TOOL_NAME = "memory_withdraw";
export const MEMORY_PROPOSAL_MAX_LENGTH = 500;
export const MEMORY_PROPOSAL_REASON_MAX_LENGTH = 300;

/** Providers prefix T3's tools differently (`mcp__t3-code__`, `t3-code.`, `t3-code_`). */
export function isMemoryProposeToolName(toolName: string | null | undefined): boolean {
  return toolName != null && /(?:^|[_.:/\s-])memory_propose$/.test(toolName.trim().toLowerCase());
}

export const MemoryProposalText = TrimmedNonEmptyString.check(
  Schema.isMaxLength(MEMORY_PROPOSAL_MAX_LENGTH),
);

/**
 * Accept for me (this person in this project), accept for the team (this project), or reject. A
 * change or removal of an existing memory already has its file, so it is accepted or rejected.
 */
export const MemoryChoice = Schema.Literals(["me", "team", "reject", "accept"]);
export type MemoryChoice = typeof MemoryChoice.Type;

/** A person's choice, or the agent taking its proposal back, which no person can send. */
export const MemoryDecisionChoice = Schema.Literals([
  "me",
  "team",
  "reject",
  "accept",
  "withdrawn",
]);
export type MemoryDecisionChoice = typeof MemoryDecisionChoice.Type;

/** A change or removal of an existing line; an addition has no kind, as older proposals do not. */
export const MemoryProposalKind = Schema.Literals(["change", "remove"]);
export type MemoryProposalKind = typeof MemoryProposalKind.Type;

export const MemoryProposalUndo = Schema.Struct({
  undoneAt: Schema.String,
  pullRequestUrl: Schema.NullOr(TrimmedNonEmptyString),
  merged: Schema.Boolean,
  problem: Schema.NullOr(Schema.String),
});
export type MemoryProposalUndo = typeof MemoryProposalUndo.Type;

export const MemoryProposalDecision = Schema.Struct({
  choice: MemoryDecisionChoice,
  /** What was saved, as the person left it; null for a rejection, a withdrawal or a removal. */
  text: Schema.NullOr(Schema.String),
  /** The file it was added to or edited in; null for a rejection or a withdrawal. */
  file: Schema.NullOr(TrimmedNonEmptyString),
  decidedAt: Schema.String,
  pullRequestUrl: Schema.NullOr(TrimmedNonEmptyString),
  merged: Schema.Boolean,
  /** Why an accepted memory is not merged yet. */
  problem: Schema.NullOr(Schema.String),
  /** The agent's reason for withdrawing it. */
  reason: Schema.optional(Schema.String),
  /** Set once a person undid what accepting did. */
  undo: Schema.optional(MemoryProposalUndo),
});
export type MemoryProposalDecision = typeof MemoryProposalDecision.Type;

export const MemoryProposal = Schema.Struct({
  id: TrimmedNonEmptyString,
  threadId: ThreadId,
  threadTitle: Schema.String,
  /** The new line; for a removal, the line it removes, so the required field stays simple. */
  text: MemoryProposalText,
  /** Why the agent proposed it; shown, never saved. */
  reason: Schema.String,
  createdAt: Schema.String,
  decision: Schema.NullOr(MemoryProposalDecision),
  /** Set when the proposal is for a category's own file instead of the general memory files. */
  category: Schema.optional(MemoryCategory),
  /**
   * The existing line this one takes the place of: with a category, its active memory; otherwise
   * the line a change or removal edits. Absent for an addition.
   */
  replaces: Schema.optional(Schema.String),
  kind: Schema.optional(MemoryProposalKind),
  /** Where the line a change or removal edits is, as found when it was proposed. */
  scope: Schema.optional(MemoryScope),
  file: Schema.optional(TrimmedNonEmptyString),
});
export type MemoryProposal = typeof MemoryProposal.Type;

/** Dates are days, as YYYY-MM-DD; null where a hand-edited line does not say. */
export const VoiceAgentMemory = Schema.Struct({
  text: Schema.String,
  savedOn: Schema.NullOr(Schema.String),
});
export type VoiceAgentMemory = typeof VoiceAgentMemory.Type;

export const VoiceAgentMemoryLogEntry = Schema.Struct({
  text: Schema.String,
  savedOn: Schema.NullOr(Schema.String),
  replacedOn: Schema.NullOr(Schema.String),
  /** The memory that took its place. */
  replacedBy: Schema.NullOr(Schema.String),
});
export type VoiceAgentMemoryLogEntry = typeof VoiceAgentMemoryLogEntry.Type;

export const VoiceAgentMemoryDocument = Schema.Struct({
  /** The viewer's own file in the team repository; null when there is none here. */
  file: Schema.NullOr(TrimmedNonEmptyString),
  /** Why there is no file here, such as the GitHub CLI being signed out. */
  unavailable: Schema.NullOr(Schema.String),
  active: Schema.Array(VoiceAgentMemory),
  /** Replaced memories, newest first: kept in the file, never sent to an agent unasked. */
  earlier: Schema.Array(VoiceAgentMemoryLogEntry),
});
export type VoiceAgentMemoryDocument = typeof VoiceAgentMemoryDocument.Type;

/** One line of a memory file and who last wrote it; the attribution is null where git cannot say. */
export const MemoryLine = Schema.Struct({
  text: Schema.String,
  author: Schema.NullOr(Schema.String),
  authoredAt: Schema.NullOr(IsoDateTime),
  commit: Schema.NullOr(TrimmedNonEmptyString),
  /** From a squash merge's "(#N)" title suffix. */
  pullRequest: Schema.NullOr(Schema.Int),
});
export type MemoryLine = typeof MemoryLine.Type;

export const MemoryDocument = Schema.Struct({
  scope: MemoryScope,
  /** The file in the team repository; null when this scope has none here. */
  file: Schema.NullOr(TrimmedNonEmptyString),
  /** The catalog project's name or the GitHub login; null for the team. */
  label: Schema.NullOr(Schema.String),
  /** The file's text; empty when the file does not exist yet. */
  text: Schema.String,
  /** The text's lines, each with its last change in the team repository's history. */
  lines: Schema.Array(MemoryLine),
  /** Why the scope has no file here, such as the GitHub CLI being signed out. */
  unavailable: Schema.NullOr(Schema.String),
});
export type MemoryDocument = typeof MemoryDocument.Type;

export const MemoryView = Schema.Struct({
  /** The team catalog's git URL; null when the environment has none. */
  source: Schema.NullOr(TrimmedNonEmptyString),
  revision: Schema.NullOr(TrimmedNonEmptyString),
  /** When the team catalog was last fetched; null before the first fetch. */
  fetchedAt: Schema.NullOr(IsoDateTime),
  refreshing: Schema.Boolean,
  /** The last catalog fetch's failure; the documents stay those of the last good fetch. */
  error: Schema.NullOr(Schema.String),
  viewer: TeamCatalogViewer,
  /** Team, project, personal, then personal in this project. */
  documents: Schema.Array(MemoryDocument),
  /** What agents in this project's threads proposed, newest first. */
  proposals: Schema.Array(MemoryProposal),
  /** Exactly what agents in this project's threads get; null when every document is empty. */
  block: Schema.NullOr(Schema.String),
  /** The documents were over the size limit, so the block leaves the end out. */
  truncated: Schema.Boolean,
  /** The viewer's voice agent memories, which the block never contains. */
  voiceAgent: VoiceAgentMemoryDocument,
});
export type MemoryView = typeof MemoryView.Type;

export const MemoryProjectInput = Schema.Struct({ projectId: ProjectId });
export type MemoryProjectInput = typeof MemoryProjectInput.Type;

export const MemoryPendingSubscribeInput = Schema.Struct({});

export const PendingMemoryProposal = Schema.Struct({
  projectId: ProjectId,
  proposal: MemoryProposal,
});
export type PendingMemoryProposal = typeof PendingMemoryProposal.Type;

/** Every project's unanswered proposals, newest first. */
export const PendingMemoryProposals = Schema.Array(PendingMemoryProposal);
export type PendingMemoryProposals = typeof PendingMemoryProposals.Type;

export const MemoryProposeInput = Schema.Struct({
  projectId: ProjectId,
  scope: MemoryScope,
  /** The catalog revision the text was edited from. */
  baseRevision: TrimmedNonEmptyString,
  text: Schema.String.check(Schema.isMaxLength(MEMORY_MAX_BYTES)),
});
export type MemoryProposeInput = typeof MemoryProposeInput.Type;

export const MemoryDecideInput = Schema.Struct({
  projectId: ProjectId,
  proposalId: TrimmedNonEmptyString,
  choice: MemoryChoice,
  /** The proposal as the person edited it; ignored for a rejection or a removal. */
  text: MemoryProposalText,
  /** Target scope for additions: personal/personal-project with "me", team/project with "team". */
  scope: Schema.optional(MemoryScope),
});
export type MemoryDecideInput = typeof MemoryDecideInput.Type;

export const MemoryUndoInput = Schema.Struct({
  projectId: ProjectId,
  proposalId: TrimmedNonEmptyString,
});
export type MemoryUndoInput = typeof MemoryUndoInput.Type;

const byteLength = (text: string) => new TextEncoder().encode(text).length;

function cutToBytes(text: string, budget: number): string {
  const cut = new TextDecoder().decode(new TextEncoder().encode(text).slice(0, budget));
  // Drop a character split by the cut, then the partial line.
  const whole = cut.endsWith("�") ? cut.slice(0, -1) : cut;
  const lineEnd = whole.lastIndexOf("\n");
  return lineEnd > 0 ? whole.slice(0, lineEnd) : whole;
}

/** Keeps the most specific sections (at the end) whole and trims earlier ones to fit `budget`. */
function trimSectionsKeepingLatest(sections: ReadonlyArray<string>, budget: number): string {
  const kept: Array<string> = [];
  let remaining = budget;
  for (let index = sections.length - 1; index >= 0; index -= 1) {
    const section = sections[index]!;
    const separator = kept.length === 0 ? 0 : 2;
    const needed = byteLength(section) + separator;
    if (needed <= remaining) {
      kept.unshift(section);
      remaining -= needed;
      continue;
    }
    const sliceBudget = remaining - separator;
    if (sliceBudget > 0) {
      const trimmed = cutToBytes(section, sliceBudget);
      // Drop a section when only its "From ...:" header fits and more-specific sections already fit.
      if (trimmed !== "" && (kept.length === 0 || trimmed.includes("\n"))) {
        kept.unshift(trimmed);
      }
    }
    break;
  }
  return kept.join("\n\n");
}

function scopeHeading(document: Pick<MemoryDocument, "scope" | "label">): string {
  switch (document.scope) {
    case "team":
      return "for everyone on the team";
    case "project":
      return `for the project ${document.label ?? ""}`.trimEnd();
    case "personal":
      return `for ${document.label ?? "you"} only`;
    case "personal-project":
      return `for ${document.label ?? "you"} only, in this project`;
  }
}

/**
 * The `<memory>` block agents get: each non-empty document, team first and personal last, so the
 * more specific one comes later and wins. Where agents can propose memory it says when to, even
 * with nothing saved yet; otherwise null when there is nothing to send.
 */
export function buildMemoryBlock(input: {
  readonly documents: ReadonlyArray<Pick<MemoryDocument, "scope" | "file" | "label" | "text">>;
  /** Where a change is proposed, such as `github.com/team/home`. */
  readonly repository: string | null;
  /** The thread's project is in the catalog, so `memory_propose` can save to it. */
  readonly proposable: boolean;
}): { readonly text: string; readonly truncated: boolean } | null {
  const closing = `</${MEMORY_TAG}>`;
  const sections = input.documents.flatMap((document) => {
    // A closing tag inside a file would end the block early.
    const text = document.text.replaceAll(closing, "").trim();
    return document.file === null || text === ""
      ? []
      : [`From ${document.file} (${scopeHeading(document)}):\n${text}`];
  });
  if (sections.length === 0 && !input.proposable) return null;
  const header = [
    `<${MEMORY_TAG}>`,
    "Memory from the team repository: standing instructions and facts. Follow it unless the user says otherwise; a later section is more specific and wins over an earlier one.",
  ].join("\n");
  const footer = [
    input.proposable
      ? `When the user states a preference, corrects you on the same thing twice, or you learn a fact about this project that later threads will need, call ${MEMORY_PROPOSE_TOOL_NAME} with one short line in plain words and why. Write it neutrally (no "me" or the user's name), since the user may accept it for the team. The user accepts it for themselves or the team from a card in the chat. Keep working; do not wait for or ask about the answer. To change or remove a saved line, call ${MEMORY_PROPOSE_TOOL_NAME} with replaces set to its exact text, and text for the new line or no text to remove it.`
      : `To add or change a memory, open a pull request that edits these files under ${MEMORY_DIRECTORY}/${input.repository === null ? " in the team repository" : ` in ${input.repository}`}, or ask the user to change it in the Memory panel.`,
    closing,
  ].join("\n");
  const body = sections.length === 0 ? "Nothing is saved yet." : sections.join("\n\n");
  const whole = `${header}\n\n${body}\n\n${footer}`;
  if (byteLength(whole) <= MEMORY_MAX_BYTES) return { text: whole, truncated: false };
  const notice = "(Earlier memory was trimmed: this memory is over the size limit.)";
  const budget = MEMORY_MAX_BYTES - byteLength(`${header}\n\n${notice}\n\n\n\n${footer}`);
  const trimmed = trimSectionsKeepingLatest(sections, Math.max(0, budget));
  return {
    text:
      trimmed === ""
        ? `${header}\n\n${notice}\n\n${footer}`
        : `${header}\n\n${notice}\n\n${trimmed}\n\n${footer}`,
    truncated: true,
  };
}
