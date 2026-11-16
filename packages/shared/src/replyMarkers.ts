// The `Re:` lines an agent opens a reply with to name the user messages it answers. T3 Code's
// instructions teach the format (provider-core's replyMarkerInstructions.ts); the web client
// draws the lines as a link to the exchange.

export interface ReLine {
  /** What the client shows: the line without its bold. */
  readonly text: string;
  /** The words quoted from the user's message; null while the line is still streaming. */
  readonly excerpt: string | null;
}

const RE_PREFIX = '**Re:** "';
// String checks, not a regex: the excerpt check must stay linear on long agent lines.
const reLineExcerpt = (row: string) => {
  const line = row.trimEnd();
  if (!line.startsWith(RE_PREFIX) || !line.endsWith('"')) return null;
  const excerpt = line.slice(RE_PREFIX.length, -1);
  return excerpt.trim() === "" ? null : excerpt;
};
// A streaming reply's unfinished last line that can still become a Re: line.
const PENDING_RE_LINE = /^\*\*Re:\*\*(?: (?:".*)?)?$/;

const displayText = (row: string) => row.trimEnd().replace("**Re:**", "Re:");

/**
 * Splits off the `**Re:** "words"` lines a reply opens with; any other shape stays in the body.
 * While streaming, an unfinished last line that can still become one counts already, so it does
 * not restyle when its closing quote arrives.
 */
export function splitReLines(
  text: string,
  streaming = false,
): { readonly lines: ReadonlyArray<ReLine>; readonly body: string } | null {
  const rows = text.trimStart().split("\n");
  const lines: ReLine[] = [];
  for (const row of rows) {
    const excerpt = reLineExcerpt(row);
    if (excerpt === null) break;
    lines.push({ text: displayText(row), excerpt });
  }
  const last = rows.at(-1)!;
  if (streaming && lines.length === rows.length - 1 && PENDING_RE_LINE.test(last)) {
    lines.push({ text: displayText(last), excerpt: null });
  }
  if (lines.length === 0) return null;
  const body = rows
    .slice(lines.length)
    .join("\n")
    .replace(/^(?:[ \t]*\r?\n)+/, "");
  return { lines, body };
}

/** The text a reply's quoted opening starts from: the body after any `Re:` lines. */
export function textAfterReLines(text: string): string {
  const body = splitReLines(text)?.body ?? text;
  return body.trim() === "" ? text : body;
}
