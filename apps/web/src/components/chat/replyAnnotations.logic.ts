import type { AssistantCitation } from "@t3tools/contracts";
import {
  collectAssistantCitations,
  serializeAssistantCitation,
} from "@t3tools/shared/assistantCitations";

/** The prompt as sent: the text, then each annotation as a quote link on its own line. */
export function appendAnnotationCitations(
  prompt: string,
  citations: ReadonlyArray<AssistantCitation>,
): string {
  if (citations.length === 0) return prompt;
  const links = citations.map(serializeAssistantCitation).join("\n");
  const text = prompt.trimEnd();
  return text.length > 0 ? `${text}\n\n${links}` : links;
}

/** Splits at most `limit` quote links that end the text, one per line, back off it. */
export function splitReplyAnnotations(
  text: string,
  limit: number,
): {
  readonly text: string;
  readonly citations: ReadonlyArray<AssistantCitation>;
} {
  let rest = text.trimEnd();
  const matches = collectAssistantCitations(rest);
  const citations: AssistantCitation[] = [];
  for (let index = matches.length - 1; index >= 0 && citations.length < limit; index -= 1) {
    const match = matches[index]!;
    if (match.end !== rest.length) break;
    const before = rest.slice(0, match.start);
    if (before.length > 0 && !before.endsWith("\n")) break;
    citations.unshift(match.citation);
    rest = before.endsWith("\n") ? before.slice(0, -1) : before;
  }
  return citations.length === 0 ? { text, citations } : { text: rest.trimEnd(), citations };
}

/** The send snapshot with the `count` annotations the send added taken back off its draft text. */
export function withoutSentAnnotations<T extends { readonly draftText: string }>(
  snapshot: T,
  count: number,
): T {
  return count === 0
    ? snapshot
    : { ...snapshot, draftText: splitReplyAnnotations(snapshot.draftText, count).text };
}

/** The annotations a send added: the quote links its message text has beyond its draft text. */
export function sentAnnotationCitations(snapshot: {
  readonly messageText: string;
  readonly draftText: string;
}): ReadonlyArray<AssistantCitation> {
  const count =
    collectAssistantCitations(snapshot.messageText).length -
    collectAssistantCitations(snapshot.draftText).length;
  return count > 0 ? splitReplyAnnotations(snapshot.messageText, count).citations : [];
}
