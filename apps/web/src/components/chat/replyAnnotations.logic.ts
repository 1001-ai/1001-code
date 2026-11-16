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

/** Splits the quote links that end the text, one per line, back off it. */
export function splitReplyAnnotations(text: string): {
  readonly text: string;
  readonly citations: ReadonlyArray<AssistantCitation>;
} {
  let rest = text.trimEnd();
  const matches = collectAssistantCitations(rest);
  const citations: AssistantCitation[] = [];
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    const match = matches[index]!;
    if (match.end !== rest.length) break;
    const before = rest.slice(0, match.start);
    if (before.length > 0 && !before.endsWith("\n")) break;
    citations.unshift(match.citation);
    rest = before.endsWith("\n") ? before.slice(0, -1) : before;
  }
  return citations.length === 0 ? { text, citations } : { text: rest.trimEnd(), citations };
}
