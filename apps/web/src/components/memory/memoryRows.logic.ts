import type { MemoryLine } from "@t3tools/contracts";

/** A memory file as the panel shows it: headings as section titles, other lines as rows. */
export type MemoryRow =
  | { readonly kind: "heading"; readonly index: number; readonly text: string }
  | {
      readonly kind: "item";
      readonly index: number;
      /** The list marker the line starts with, such as "- "; empty for a plain line. */
      readonly marker: string;
      readonly text: string;
      readonly line: MemoryLine;
    };

/** Changes to a file's lines, by line index, kept in the panel until they are proposed. */
export interface MemoryEdits {
  readonly edited: Readonly<Record<number, string>>;
  readonly removed: ReadonlyArray<number>;
  readonly added: ReadonlyArray<string>;
}

export const NO_EDITS: MemoryEdits = { edited: {}, removed: [], added: [] };

const HEADING = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/;
const LIST_ITEM = /^(\s*(?:[-*+]|\d+[.)])\s+)(.*)$/;

export function memoryRows(lines: ReadonlyArray<MemoryLine>): ReadonlyArray<MemoryRow> {
  return lines.flatMap((line, index): ReadonlyArray<MemoryRow> => {
    if (line.text.trim() === "") return [];
    const heading = HEADING.exec(line.text);
    if (heading) return [{ kind: "heading", index, text: heading[1]! }];
    const item = LIST_ITEM.exec(line.text);
    return [
      {
        kind: "item",
        index,
        marker: item?.[1] ?? "",
        text: item?.[2] ?? line.text.trim(),
        line,
      },
    ];
  });
}

/** One memory is one line, so a pasted line break becomes a space. */
const singleLine = (text: string): string => text.replace(/\s*\n\s*/g, " ").trim();

/** Editing a row back to what the file says drops the edit; editing it to nothing removes it. */
export function editRow(edits: MemoryEdits, row: { index: number; text: string }, text: string) {
  const next = singleLine(text);
  const { [row.index]: _previous, ...edited } = edits.edited;
  if (next === "") return removeRow({ ...edits, edited }, row.index);
  return { ...edits, edited: next === row.text ? edited : { ...edited, [row.index]: next } };
}

export function removeRow(edits: MemoryEdits, index: number): MemoryEdits {
  return edits.removed.includes(index) ? edits : { ...edits, removed: [...edits.removed, index] };
}

/** Undoes an edit or a removal. */
export function restoreRow(edits: MemoryEdits, index: number): MemoryEdits {
  const { [index]: _previous, ...edited } = edits.edited;
  return { ...edits, edited, removed: edits.removed.filter((candidate) => candidate !== index) };
}

/** Sets a new row's text; a new row left empty is dropped. */
export function setAdded(edits: MemoryEdits, position: number, text: string): MemoryEdits {
  const next = singleLine(text);
  const added =
    next === ""
      ? edits.added.filter((_, candidate) => candidate !== position)
      : position >= edits.added.length
        ? [...edits.added, next]
        : edits.added.map((existing, candidate) => (candidate === position ? next : existing));
  return { ...edits, added };
}

export function changeCount(edits: MemoryEdits): number {
  const edited = Object.keys(edits.edited).filter(
    (index) => !edits.removed.includes(Number(index)),
  ).length;
  return edited + edits.removed.length + edits.added.length;
}

/** The whole file with the edits, keeping headings, blank lines and order; new rows go last. */
export function memoryFileText(lines: ReadonlyArray<MemoryLine>, edits: MemoryEdits): string {
  const rows = new Map(
    memoryRows(lines).flatMap((row) => (row.kind === "item" ? [[row.index, row] as const] : [])),
  );
  const kept = lines.flatMap((line, index) => {
    if (edits.removed.includes(index)) return [];
    const edited = edits.edited[index];
    return edited === undefined ? [line.text] : [`${rows.get(index)?.marker ?? ""}${edited}`];
  });
  while (edits.added.length > 0 && kept.length > 0 && kept.at(-1)!.trim() === "") kept.pop();
  const all = [...kept, ...edits.added.map((text) => `- ${text}`)];
  return all.length === 0 ? "" : `${all.join("\n")}\n`;
}

/** Text and code spans, for a row's inline markdown. */
export function inlineCodeParts(
  text: string,
): ReadonlyArray<{ readonly code: boolean; readonly text: string }> {
  return text
    .split(/(`[^`\n]+`)/)
    .filter((part) => part !== "")
    .map((part) =>
      part.length > 2 && part.startsWith("`") && part.endsWith("`")
        ? { code: true, text: part.slice(1, -1) }
        : { code: false, text: part },
    );
}

const HOSTED_SOURCE = [
  /^https?:\/\/(?:[^@/\s]+@)?([^/:\s]+)(?::\d+)?\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i,
  /^ssh:\/\/(?:[^@/\s]+@)?([^/:\s]+)(?::\d+)?\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i,
  /^(?:[^@/:\s]+@)?([^/:\s]+):([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/,
];

/** The pull request's page on the catalog's host; null for a path or file URL. */
export function pullRequestUrl(source: string | null, pullRequest: number): string | null {
  if (source === null) return null;
  for (const pattern of HOSTED_SOURCE) {
    const match = pattern.exec(source);
    if (match)
      return `https://${match[1]!.toLowerCase()}/${match[2]}/${match[3]}/pull/${pullRequest}`;
  }
  return null;
}
