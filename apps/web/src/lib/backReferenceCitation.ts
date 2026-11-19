import type { AssistantCitation, MessageId, ScopedThreadRef } from "@t3tools/contracts";
import { matchQuote } from "@t3tools/shared/backReferences";

// A back-reference opens its message through the citation reveal. Offsets no selection can reach
// mark its citation, so the reveal finds the quote in the shown text by back-reference matching
// instead of the saved offsets. The URL carries the mark, so a reload reveals the same way.
const BACK_REFERENCE_END = Number.MAX_SAFE_INTEGER;
const BACK_REFERENCE_START = BACK_REFERENCE_END - 1;

export function backReferenceCitation(
  threadRef: ScopedThreadRef,
  messageId: MessageId,
  excerpt: string,
): AssistantCitation {
  return {
    version: 1,
    environmentId: threadRef.environmentId,
    threadId: threadRef.threadId,
    messageId,
    text: excerpt,
    start: BACK_REFERENCE_START,
    end: BACK_REFERENCE_END,
    prefix: "",
    suffix: "",
  };
}

export function isBackReferenceCitation(selector: { start: number; end: number }): boolean {
  return selector.start === BACK_REFERENCE_START && selector.end === BACK_REFERENCE_END;
}

/** Where a back-reference's quote sits in a message's shown text: first exact, else closest. */
export function findBackReferenceText(
  text: string,
  quote: string,
): { start: number; end: number } | null {
  const match = matchQuote(text, quote);
  return match === null ? null : { start: match.start, end: match.end };
}

export const BACK_REFERENCE_NOT_FOUND = {
  title: "Earlier text not found",
  description: "No earlier message in this thread holds those words.",
} as const;
