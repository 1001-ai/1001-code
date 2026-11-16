import {
  AGENTS_BOARD_FIELD_MAX_LENGTH,
  AGENTS_BOARD_INBOX_DIRECTORY,
  AGENTS_BOARD_INBOX_EVERYONE,
  AGENTS_BOARD_REPORTS_DIRECTORY,
  AGENTS_BOARD_TEXT_MAX_LENGTH,
  type AgentsBoardAgent,
  type AgentsBoardAgentMessage,
  type AgentsBoardData,
  type AgentsBoardMessage,
  type AgentsBoardPersonMessage,
  type AgentsBoardStatus,
  agentsBoardMediaType,
  isAgentsBoardAgentId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

/**
 * Reads the files of an agents branch into a board. Many different agents write them, so nothing
 * here trusts their shape: what does not parse is left out, and every value is capped and plain.
 */
export interface AgentsBoardFile {
  readonly path: string;
  readonly text: string;
}

export interface AgentsBoardLimits {
  /** Files read per folder (`reports`, `inbox`). */
  readonly maxFiles: number;
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
  /** The newest entries kept of one file. */
  readonly maxEntriesPerFile: number;
  /** The newest messages kept of the whole board. */
  readonly maxMessages: number;
  readonly maxMediaPerMessage: number;
}

export const AGENTS_BOARD_LIMITS: AgentsBoardLimits = {
  maxFiles: 200,
  maxFileBytes: 512 * 1024,
  maxTotalBytes: 8 * 1024 * 1024,
  maxEntriesPerFile: 300,
  maxMessages: 500,
  maxMediaPerMessage: 4,
};

export type AgentsBoardFileKind =
  | { readonly kind: "report"; readonly agentId: string }
  | { readonly kind: "inbox"; readonly to: string | null };

/** What a path on the branch is, or null for a file the board does not read. */
export function agentsBoardFileKind(path: string): AgentsBoardFileKind | null {
  const match = /^([a-z]+)\/([^/]+)\.md$/.exec(path);
  const name = match?.[2];
  if (match === null || name === undefined || !isAgentsBoardAgentId(name)) return null;
  // Each folder's README documents the format, with example entries; it is not an agent's file.
  if (name.toLowerCase() === "readme") return null;
  if (match[1] === AGENTS_BOARD_REPORTS_DIRECTORY) return { kind: "report", agentId: name };
  if (match[1] === AGENTS_BOARD_INBOX_DIRECTORY) {
    return { kind: "inbox", to: name === AGENTS_BOARD_INBOX_EVERYONE ? null : name };
  }
  return null;
}

const STATUSES: ReadonlySet<string> = new Set<AgentsBoardStatus>([
  "started",
  "working",
  "blocked",
  "question",
  "done",
]);

const UNSAFE_CHARACTERS = /[\p{Cc}‪-‮⁦-⁩]/gu;

const clip = (value: string, maxLength: number) =>
  value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;

/** One line of plain text, or null when nothing is left. */
function field(value: string): string | null {
  const plain = value
    .replace(UNSAFE_CHARACTERS, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^`([^`]*)`$/, "$1")
    .trim();
  return plain === "" ? null : clip(plain, AGENTS_BOARD_FIELD_MAX_LENGTH);
}

function body(lines: ReadonlyArray<string>): string {
  const plain = lines
    .map((line) => line.replace(UNSAFE_CHARACTERS, " ").trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return clip(plain, AGENTS_BOARD_TEXT_MAX_LENGTH);
}

const TIME =
  /^(\d{4}-\d{2}-\d{2})[Tt ](\d{2}:\d{2})(?::(\d{2})(?:[.,]\d+)?)?\s*([Zz]|[+-]\d{2}:?\d{2})?/;

/** The time at the start of the text as UTC, and what follows it. A time with no zone is UTC. */
function leadingTime(text: string): { readonly at: string; readonly rest: string } | null {
  const match = TIME.exec(text);
  if (match === null) return null;
  const [whole, date, minutes, seconds = "00", zone = "Z"] = match;
  const offset =
    zone.toUpperCase() === "Z"
      ? "Z"
      : zone.includes(":")
        ? zone
        : `${zone.slice(0, 3)}:${zone.slice(3)}`;
  const time = Date.parse(`${date}T${minutes}:${seconds}${offset}`);
  if (Number.isNaN(time)) return null;
  return {
    at: DateTime.formatIso(DateTime.makeUnsafe(time)),
    rest: text.slice(whole.length),
  };
}

interface RawEntry {
  /** The entry's place among the file's `##` headings, parsed or not. */
  readonly index: number;
  readonly at: string;
  /** What follows the time in the heading: a status, or `from <name>`. */
  readonly label: string;
  readonly fields: Map<string, string>;
  readonly media: Array<string>;
  readonly lines: Array<string>;
}

const BULLET = /^\s*[-*]\s+([A-Za-z]+)\s*:\s*(.*)$/;
const ENTRY_KEYS: ReadonlySet<string> = new Set(["branch", "pr", "next", "needs", "media", "via"]);
const HEADER_KEYS: ReadonlySet<string> = new Set(["owner", "tool", "task", "started"]);

function mediaPaths(value: string): ReadonlyArray<string> {
  return (value.match(/media\/[^\s,;()`'"<>]+/g) ?? []).filter(
    (path) => agentsBoardMediaType(path) !== null,
  );
}

function parseFile(
  text: string,
  limits: AgentsBoardLimits,
): {
  readonly header: Map<string, string>;
  readonly entries: ReadonlyArray<RawEntry>;
  readonly truncated: boolean;
} {
  const header = new Map<string, string>();
  const entries: Array<RawEntry> = [];
  let current: RawEntry | null = null;
  let headings = 0;
  for (const line of text.split(/\r?\n/)) {
    const heading = /^##(?!#)\s*(.*)$/.exec(line);
    if (heading !== null) {
      const time = leadingTime((heading[1] ?? "").trim());
      current =
        time === null
          ? null
          : {
              index: headings,
              at: time.at,
              label: time.rest.replace(/^[\s·•|:–—-]+/u, "").trim(),
              fields: new Map(),
              media: [],
              lines: [],
            };
      headings += 1;
      if (current !== null) entries.push(current);
      continue;
    }
    const bullet = BULLET.exec(line);
    const key = bullet?.[1]?.toLowerCase();
    const value = bullet?.[2] ?? "";
    if (headings === 0) {
      if (key !== undefined && HEADER_KEYS.has(key) && !header.has(key)) header.set(key, value);
      continue;
    }
    // Under a heading that did not parse: skipped with it.
    if (current === null) continue;
    if (key === "media") {
      for (const path of mediaPaths(value)) {
        if (current.media.length < limits.maxMediaPerMessage && !current.media.includes(path)) {
          current.media.push(path);
        }
      }
    } else if (key !== undefined && ENTRY_KEYS.has(key)) {
      current.fields.set(key, value);
    } else {
      current.lines.push(line);
    }
  }
  return {
    header,
    entries: entries.slice(-limits.maxEntriesPerFile),
    truncated: entries.length > limits.maxEntriesPerFile,
  };
}

/** "nothing" and its like mean no person is needed. */
function needsOf(value: string | undefined): string | null {
  const needs = value === undefined ? null : field(value);
  if (needs === null) return null;
  return /^(?:nothing|none|no|n\/a|-+)[.!]?$/i.test(needs) ? null : needs;
}

const fieldOf = (fields: ReadonlyMap<string, string>, key: string): string | null => {
  const value = fields.get(key);
  return value === undefined ? null : field(value);
};

interface ParsedFile {
  readonly agent: AgentsBoardAgent | null;
  readonly messages: ReadonlyArray<AgentsBoardMessage>;
  readonly truncated: boolean;
}

export function parseAgentReport(
  path: string,
  agentId: string,
  text: string,
  limits: AgentsBoardLimits = AGENTS_BOARD_LIMITS,
): ParsedFile {
  const { header, entries, truncated } = parseFile(text, limits);
  const messages = entries.map((entry): AgentsBoardAgentMessage => {
    const status = entry.label.toLowerCase();
    return {
      _tag: "agent",
      id: `${path}#${entry.index}`,
      agentId,
      at: entry.at,
      status: STATUSES.has(status) ? (status as AgentsBoardStatus) : null,
      text: body(entry.lines),
      branch: fieldOf(entry.fields, "branch"),
      pr: fieldOf(entry.fields, "pr"),
      next: fieldOf(entry.fields, "next"),
      needs: needsOf(entry.fields.get("needs")),
      media: entry.media,
    };
  });
  // Two entries can carry one time; the later one in the file is the newer.
  const latest = messages.reduce<AgentsBoardAgentMessage | null>(
    (newest, message) => (newest === null || message.at >= newest.at ? message : newest),
    null,
  );
  return {
    agent: {
      id: agentId,
      owner: fieldOf(header, "owner"),
      tool: fieldOf(header, "tool"),
      task: fieldOf(header, "task"),
      started: leadingTime((header.get("started") ?? "").trim())?.at ?? null,
      latestStatus: latest?.status ?? null,
      latestAt: latest?.at ?? null,
      needs: latest?.needs ?? null,
    },
    messages,
    truncated,
  };
}

export function parseAgentInbox(
  path: string,
  to: string | null,
  text: string,
  limits: AgentsBoardLimits = AGENTS_BOARD_LIMITS,
): ParsedFile {
  const { entries, truncated } = parseFile(text, limits);
  return {
    agent: null,
    messages: entries.map((entry): AgentsBoardPersonMessage => ({
      _tag: "person",
      id: `${path}#${entry.index}`,
      from: field(entry.label.replace(/^from\b\s*/i, "")),
      to,
      at: entry.at,
      text: body(entry.lines),
      via: fieldOf(entry.fields, "via"),
    })),
    truncated,
  };
}

/** `alreadyTruncated` says the caller left files out before reading them. */
export function buildAgentsBoard(
  files: ReadonlyArray<AgentsBoardFile>,
  limits: AgentsBoardLimits = AGENTS_BOARD_LIMITS,
  alreadyTruncated = false,
): AgentsBoardData {
  const agents: Array<AgentsBoardAgent> = [];
  const all: Array<AgentsBoardMessage> = [];
  let truncated = alreadyTruncated;
  for (const file of files.toSorted((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  )) {
    const kind = agentsBoardFileKind(file.path);
    if (kind === null) continue;
    const parsed =
      kind.kind === "report"
        ? parseAgentReport(file.path, kind.agentId, file.text, limits)
        : parseAgentInbox(file.path, kind.to, file.text, limits);
    if (parsed.agent !== null) agents.push(parsed.agent);
    all.push(...parsed.messages);
    truncated ||= parsed.truncated;
  }
  // The sort is stable, so messages with one time keep their file's order.
  const ordered = all.toSorted((left, right) =>
    left.at < right.at ? -1 : left.at > right.at ? 1 : 0,
  );
  const messages = ordered.slice(-limits.maxMessages);
  return {
    agents,
    messages,
    activeCount: agents.filter((agent) => agent.latestStatus !== "done").length,
    needsPersonCount: agents.filter(
      (agent) =>
        agent.needs !== null ||
        agent.latestStatus === "blocked" ||
        agent.latestStatus === "question",
    ).length,
    truncated: truncated || ordered.length > messages.length,
  };
}

/**
 * A person's message as one plain line. It becomes part of a file other agents parse, so nothing
 * in it may read as a heading or a field: line breaks and control characters become spaces, and
 * what could open a heading or a bullet is taken off the front.
 */
export function inboxMessageText(text: string): string {
  return text
    .replace(UNSAFE_CHARACTERS, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[#\-*>\s]+/, "");
}

/** The name a message is signed with: one word of letters, digits, `.`, `'` or `-`. */
export function inboxSignerName(name: string | null, login: string): string {
  const first = (name ?? "")
    .replace(UNSAFE_CHARACTERS, " ")
    .trim()
    .split(/\s+/)[0]
    ?.replace(/[^\p{L}\p{N}.'-]/gu, "")
    .slice(0, 40);
  return first === undefined || first === "" ? login : first;
}

/** The inbox file with one more entry at its end. `existing` is null for a file not there yet. */
export function withInboxEntry(
  existing: string | null,
  entry: {
    readonly to: string;
    readonly at: string;
    readonly from: string;
    readonly text: string;
    readonly via: string;
  },
): string {
  const head =
    existing === null || existing.trim() === ""
      ? `# Inbox: ${entry.to}\n`
      : existing.replace(/\s+$/, "") + "\n";
  return `${head}\n## ${entry.at} · from ${entry.from}\n\n${entry.text}\n\n- via: ${entry.via}\n`;
}
