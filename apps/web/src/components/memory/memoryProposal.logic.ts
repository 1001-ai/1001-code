import {
  isMemoryProposeToolName,
  type MemoryProposal,
  VOICE_AGENT_MEMORY_CATEGORY,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { compactDynamicToolOutput } from "@t3tools/shared/toolOutput";

type DynamicToolItem = Extract<OrchestrationV2TurnItem, { type: "dynamic_tool" }>;

export interface MemoryProposalInput {
  readonly text: string;
  readonly reason: string;
  /** The call is for the voice agent's own memories. */
  readonly voiceAgent: boolean;
  /** The voice agent memory it takes the place of; null for a new subject. */
  readonly replaces: string | null;
}

export function memoryProposalInput(input: unknown): MemoryProposalInput | null {
  if (typeof input !== "object" || input === null) return null;
  const { text, reason, category, replaces } = input as Readonly<Record<string, unknown>>;
  if (typeof text !== "string" || text.trim() === "") return null;
  const voiceAgent = category === VOICE_AGENT_MEMORY_CATEGORY;
  return {
    text: text.trim(),
    reason: typeof reason === "string" ? reason.trim() : "",
    voiceAgent,
    replaces:
      voiceAgent && typeof replaces === "string" && replaces.trim() !== "" ? replaces.trim() : null,
  };
}

/** What the card and the panel show of a proposal, or of its call before the proposal loads. */
export function proposalTarget(
  proposal: Pick<MemoryProposal, "category" | "replaces"> | undefined,
  call: Pick<MemoryProposalInput, "voiceAgent" | "replaces"> | null,
): { readonly voiceAgent: boolean; readonly replaces: string | null } {
  return proposal === undefined
    ? { voiceAgent: call?.voiceAgent ?? false, replaces: call?.replaces ?? null }
    : { voiceAgent: proposal.category !== undefined, replaces: proposal.replaces ?? null };
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
 * The proposal a tool call made. The wire drops the tool's output, so the call is matched by thread
 * and text: the first proposal made at or after the call, else the latest earlier one, which a
 * repeated call returned instead of making another.
 */
export function proposalForCall(
  proposals: ReadonlyArray<MemoryProposal>,
  call: { readonly threadId: string; readonly text: string; readonly startedAt: string },
): MemoryProposal | undefined {
  const matches = proposals
    .filter((proposal) => proposal.threadId === call.threadId && proposal.text === call.text)
    .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt));
  return matches.find((proposal) => proposal.createdAt >= call.startedAt) ?? matches.at(-1);
}
