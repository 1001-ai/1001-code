import {
  isMemoryProposeToolName,
  type MemoryProposal,
  type MemoryProposalKind,
  type MemoryScope,
  VOICE_AGENT_MEMORY_CATEGORY,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { compactDynamicToolOutput } from "@t3tools/shared/toolOutput";

type DynamicToolItem = Extract<OrchestrationV2TurnItem, { type: "dynamic_tool" }>;

export interface MemoryProposalInput {
  /** The new line; for a removal, the line it removes, as the server stores it. */
  readonly text: string;
  readonly reason: string;
  /** The call is for the voice agent's own memories. */
  readonly voiceAgent: boolean;
  /** The memory it takes the place of or removes; null for a new one. */
  readonly replaces: string | null;
  /** A change or removal of a saved line; null for an addition or a voice agent memory. */
  readonly kind: MemoryProposalKind | null;
}

const nonEmpty = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : null;

/** As the server names a saved line: without its list bullet. */
const lineText = (line: string) => line.replace(/^(?:[-*+]|\d+[.)])\s+/, "").trim();

export function memoryProposalInput(input: unknown): MemoryProposalInput | null {
  if (typeof input !== "object" || input === null) return null;
  const fields = input as Readonly<Record<string, unknown>>;
  const voiceAgent = fields.category === VOICE_AGENT_MEMORY_CATEGORY;
  const text = nonEmpty(fields.text);
  const replaces = nonEmpty(fields.replaces);
  const reason = nonEmpty(fields.reason) ?? "";
  if (voiceAgent) return text === null ? null : { text, reason, voiceAgent, replaces, kind: null };
  if (replaces === null) {
    return text === null ? null : { text, reason, voiceAgent, replaces: null, kind: null };
  }
  const old = lineText(replaces);
  return text === null
    ? { text: old, reason, voiceAgent, replaces: old, kind: "remove" }
    : { text: lineText(text), reason, voiceAgent, replaces: old, kind: "change" };
}

export interface MemoryProposalTarget {
  readonly voiceAgent: boolean;
  readonly replaces: string | null;
  readonly kind: MemoryProposalKind | null;
  /** Where the line a change or removal edits is; null until the proposal loads. */
  readonly scope: MemoryScope | null;
}

/** What the card and the panel show of a proposal, or of its call before the proposal loads. */
export function proposalTarget(
  proposal: Pick<MemoryProposal, "category" | "replaces" | "kind" | "scope"> | undefined,
  call: Pick<MemoryProposalInput, "voiceAgent" | "replaces" | "kind"> | null,
): MemoryProposalTarget {
  return proposal === undefined
    ? {
        voiceAgent: call?.voiceAgent ?? false,
        replaces: call?.replaces ?? null,
        kind: call?.kind ?? null,
        scope: null,
      }
    : {
        voiceAgent: proposal.category !== undefined,
        replaces: proposal.replaces ?? null,
        kind: proposal.kind ?? null,
        scope: proposal.scope ?? null,
      };
}

export function memoryScopeLabel(scope: MemoryScope): string {
  switch (scope) {
    case "team":
      return "Team memory";
    case "project":
      return "Project memory";
    case "personal":
      return "Your memory";
    case "personal-project":
      return "Your project memory";
  }
}

/** A `memory_propose` call that recorded a proposal; a failed one stays an ordinary tool row. */
export function isMemoryProposalItem(item: OrchestrationV2TurnItem): item is DynamicToolItem {
  return (
    item.type === "dynamic_tool" &&
    item.status === "completed" &&
    isMemoryProposeToolName(item.toolName) &&
    memoryProposalInput(item.input) !== null &&
    compactDynamicToolOutput(item.output)?.isError !== true
  );
}

/**
 * The proposal a tool call made. The wire drops the tool's output, so the call is matched by thread,
 * text and kind: the first proposal made at or after the call, else the latest earlier one, which a
 * repeated call returned instead of making another.
 */
export function proposalForCall(
  proposals: ReadonlyArray<MemoryProposal>,
  call: {
    readonly threadId: string;
    readonly text: string;
    readonly startedAt: string;
    /** The call was for the voice agent's memories; it never matches a general proposal. */
    readonly voiceAgent: boolean;
    readonly kind: MemoryProposalKind | null;
  },
): MemoryProposal | undefined {
  const matches = proposals
    .filter(
      (proposal) =>
        proposal.threadId === call.threadId &&
        proposal.text === call.text &&
        (proposal.category !== undefined) === call.voiceAgent &&
        (proposal.kind ?? null) === call.kind,
    )
    .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt));
  return matches.find((proposal) => proposal.createdAt >= call.startedAt) ?? matches.at(-1);
}
