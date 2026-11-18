// The `(↑ "words")` markers an agent writes to point back at something said earlier in the chat.
// T3 Code's instructions teach the format (provider-core's backReferenceInstructions.ts); the web
// client links each one to the earlier message holding those words.

export interface BackReference {
  /** The marker as written, parentheses included. */
  readonly text: string;
  /** The words quoted from the earlier message. */
  readonly excerpt: string;
  readonly start: number;
  readonly end: number;
}

// Straight or curly quotes; the excerpt holds no quote, parenthesis or line break, so an
// unfinished marker never matches and the scan stays linear.
const BACK_REFERENCE = /\(↑ ?["“]([^"“”()\n]{1,200})["”]\)/g;

/** The complete back-reference markers in `text`, in order. */
export function findBackReferences(text: string): ReadonlyArray<BackReference> {
  if (!text.includes("↑")) return [];
  const references: BackReference[] = [];
  for (const match of text.matchAll(BACK_REFERENCE)) {
    const excerpt = match[1]!.trim();
    if (excerpt === "") continue;
    references.push({
      text: match[0],
      excerpt,
      start: match.index,
      end: match.index + match[0].length,
    });
  }
  return references;
}
