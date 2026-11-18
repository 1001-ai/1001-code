import type { MemoryLine } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

const HEADER = /^([0-9a-f]{40}|[0-9a-f]{64}) \d+ \d+(?: \d+)?$/;
const UNCOMMITTED = /^0+$/;
const PULL_REQUEST = /\(#(\d+)\)\s*$/;

const UNKNOWN = { author: null, authoredAt: null, commit: null, pullRequest: null } as const;

type Attribution = Omit<MemoryLine, "text">;

/**
 * Reads `git blame --line-porcelain --root`, where every line repeats its commit's headers.
 * Uncommitted lines and boundary commits, whose real author git does not know, get nulls.
 */
export function parseBlamePorcelain(output: string): ReadonlyArray<MemoryLine> {
  const lines: Array<MemoryLine> = [];
  let commit: string | null = null;
  let headers = new Map<string, string>();
  for (const line of output.split("\n")) {
    if (line.startsWith("\t")) {
      lines.push({ text: line.slice(1), ...attribution(commit, headers) });
      commit = null;
      headers = new Map();
      continue;
    }
    const header = HEADER.exec(line);
    if (header) {
      commit = header[1]!;
      continue;
    }
    const space = line.indexOf(" ");
    headers.set(
      space === -1 ? line : line.slice(0, space),
      space === -1 ? "" : line.slice(space + 1),
    );
  }
  return lines;
}

function attribution(commit: string | null, headers: ReadonlyMap<string, string>): Attribution {
  if (commit === null || UNCOMMITTED.test(commit) || headers.has("boundary")) return UNKNOWN;
  const seconds = Number(headers.get("author-time"));
  const pullRequest = PULL_REQUEST.exec(headers.get("summary") ?? "");
  return {
    author: headers.get("author")?.trim() || null,
    authoredAt: Number.isFinite(seconds)
      ? DateTime.formatIso(DateTime.makeUnsafe(seconds * 1000))
      : null,
    commit,
    pullRequest: pullRequest ? Number(pullRequest[1]) : null,
  };
}

/**
 * The file's lines with the blame's attribution. A blame of another version of the file, such as
 * one taken before a fetch moved the checkout, leaves every line unattributed.
 */
export function attributeLines(
  text: string,
  blame: ReadonlyArray<MemoryLine> | null,
): ReadonlyArray<MemoryLine> {
  if (text === "") return [];
  const lines = (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n");
  const matches =
    blame !== null &&
    blame.length === lines.length &&
    blame.every((line, index) => line.text.trimEnd() === lines[index]!.trimEnd());
  return lines.map((line, index) =>
    matches ? { ...blame[index]!, text: line } : { text: line, ...UNKNOWN },
  );
}
