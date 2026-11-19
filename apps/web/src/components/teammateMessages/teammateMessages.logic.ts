import type { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";

// The first line of a routed comment: `[Linear comment <nonce> on <issue> from <sender>]`.
const HEADER = /^\[Linear comment ([0-9a-f]+) on (.+?) from ([^\]\n]+)\]/;
const LINEAR_URL = /On Linear: (https:\/\/[^\s\]]+)/;

export interface LinearCommentHeader {
  /** Random per delivery, and in both markers; a forward copies it unchanged. */
  readonly nonce: string;
  readonly issue: string;
  readonly sender: string;
}

export interface LinearComment extends LinearCommentHeader {
  readonly body: string;
  /** The comment on Linear, from the closing marker; null when the marker names none. */
  readonly url: string | null;
}

function parseHeader(text: string): (LinearCommentHeader & { readonly rest: string }) | null {
  const match = HEADER.exec(text);
  if (match === null) return null;
  return {
    nonce: match[1]!,
    issue: match[2]!,
    sender: match[3]!.trim(),
    rest: text.slice(match[0].length),
  };
}

function closingMarker(nonce: string): string {
  return `[End of Linear comment ${nonce}.`;
}

/** A routed teammate comment's parts, or null for any other message. */
export function parseLinearComment(text: string): LinearComment | null {
  const header = parseHeader(text);
  if (header === null) return null;
  const lines = header.rest.split(/\r?\n/);
  // The last line with this nonce is the server's: a comment cannot know its own nonce.
  const closingIndex = lines.findLastIndex((line) =>
    line.trimStart().startsWith(closingMarker(header.nonce)),
  );
  const bodyLines = closingIndex === -1 ? lines : lines.slice(0, closingIndex);
  return {
    nonce: header.nonce,
    issue: header.issue,
    sender: header.sender,
    body: bodyLines.join("\n").trim(),
    url: closingIndex === -1 ? null : (LINEAR_URL.exec(lines[closingIndex]!)?.[1] ?? null),
  };
}

export function firstBodyLine(body: string): string {
  return (
    body
      .split(/\r?\n/)
      .find((line) => line.trim() !== "")
      ?.trim() ?? ""
  );
}

/** One routed comment as the bell lists it. */
export interface TeammateMessage extends LinearCommentHeader {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly messageId: MessageId | null;
  readonly preview: string;
  /** When the message reached the thread (ISO). */
  readonly at: string;
}

/** Messages read from each candidate thread: its newest ones, where a fresh arrival is. */
export const SCAN_MESSAGE_COUNT = 10;

/** The routed comments among a thread's newest messages. */
export function teammateMessagesIn(
  environmentId: EnvironmentId,
  threadId: ThreadId,
  messages: ReadonlyArray<{
    readonly id: MessageId;
    readonly role: string;
    readonly text: string;
    readonly createdAt: string;
  }>,
): ReadonlyArray<TeammateMessage> {
  return messages.slice(-SCAN_MESSAGE_COUNT).flatMap((message) => {
    if (message.role !== "user") return [];
    const comment = parseLinearComment(message.text);
    if (comment === null) return [];
    return [
      {
        nonce: comment.nonce,
        issue: comment.issue,
        sender: comment.sender,
        environmentId,
        threadId,
        messageId: message.id,
        preview: firstBodyLine(comment.body),
        at: message.createdAt,
      },
    ];
  });
}

export interface ScanShell {
  readonly environmentId: EnvironmentId;
  readonly id: ThreadId;
  readonly latestUserMessageAt: string | null;
  readonly latestUserAuthoredMessageAt?: string | null | undefined;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
  readonly deletedAt: string | null;
}

export interface ScanCandidate {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  /** The scan watermark once this thread is read. */
  readonly latestUserMessageAt: string;
}

const SCAN_WINDOW_MS = 7 * 24 * 60 * 60_000;
/** Threads read per pass; the rest wait for the next one. */
const SCAN_THREAD_LIMIT = 20;

export function scanKey(environmentId: EnvironmentId, threadId: ThreadId): string {
  return `${environmentId}\u0000${threadId}`;
}

/**
 * Threads to read, newest first: active in the last week, whose last user-role message the user
 * did not type (an agent's message, a wake or a routed comment), and newer than this device's
 * last read of them. The server's message search leaves agent messages out, so they are read.
 */
export function scanCandidates(
  shells: ReadonlyArray<ScanShell>,
  scannedAt: Readonly<Record<string, string>>,
  nowMs: number,
): ReadonlyArray<ScanCandidate> {
  const since = new Date(nowMs - SCAN_WINDOW_MS).toISOString();
  return shells
    .flatMap((shell): ScanCandidate[] => {
      const at = shell.latestUserMessageAt;
      if (at === null || shell.archivedAt !== null || shell.deletedAt !== null) return [];
      if (shell.updatedAt < since) return [];
      const authored = shell.latestUserAuthoredMessageAt ?? null;
      if (authored !== null && at <= authored) return [];
      if (at <= (scannedAt[scanKey(shell.environmentId, shell.id)] ?? "")) return [];
      return [{ environmentId: shell.environmentId, threadId: shell.id, latestUserMessageAt: at }];
    })
    .toSorted((left, right) => right.latestUserMessageAt.localeCompare(left.latestUserMessageAt))
    .slice(0, SCAN_THREAD_LIMIT);
}

export interface TeammateMessagesState {
  /** Every routed comment seen and not yet handled, by nonce. */
  readonly unread: Readonly<Record<string, TeammateMessage>>;
  /** When each comment was opened or dismissed, by nonce, so a later read does not bring it back. */
  readonly handled: Readonly<Record<string, string>>;
  /** Per thread (`scanKey`), the last user-role message time this device has read up to. */
  readonly scannedAt: Readonly<Record<string, string>>;
}

export const EMPTY_TEAMMATE_MESSAGES: TeammateMessagesState = {
  unread: {},
  handled: {},
  scannedAt: {},
};

/** Marks kept; older ones fall outside the week a pass looks at. */
const HANDLED_LIMIT = 500;
const UNREAD_LIMIT = 200;
const SCANNED_LIMIT = 500;

function newestEntries<T>(
  record: Readonly<Record<string, T>>,
  at: (value: T) => string,
  limit: number,
) {
  const entries = Object.entries(record);
  if (entries.length <= limit) return record;
  return Object.fromEntries(
    entries.toSorted(([, left], [, right]) => at(right).localeCompare(at(left))).slice(0, limit),
  );
}

/**
 * Adds what a read found. A comment seen in two threads (the Inbox forwarded it) keeps the
 * newer delivery, which is where it was sent on to.
 */
export function rememberTeammateMessages(
  state: TeammateMessagesState,
  found: ReadonlyArray<TeammateMessage>,
): TeammateMessagesState {
  let unread: Record<string, TeammateMessage> | null = null;
  for (const message of found) {
    if (state.handled[message.nonce] !== undefined) continue;
    const current = (unread ?? state.unread)[message.nonce];
    if (
      current !== undefined &&
      (current.at > message.at ||
        (current.at === message.at &&
          current.threadId === message.threadId &&
          current.environmentId === message.environmentId &&
          current.preview === message.preview))
    ) {
      continue;
    }
    unread ??= { ...state.unread };
    unread[message.nonce] = message;
  }
  if (unread === null) return state;
  return { ...state, unread: newestEntries(unread, (message) => message.at, UNREAD_LIMIT) };
}

/** Opening or dismissing a comment: it leaves the list and stays out of it. */
export function handleTeammateMessages(
  state: TeammateMessagesState,
  nonces: ReadonlyArray<string>,
  nowIso: string,
): TeammateMessagesState {
  if (nonces.length === 0) return state;
  const unread = { ...state.unread };
  const handled = { ...state.handled };
  for (const nonce of nonces) {
    delete unread[nonce];
    handled[nonce] = nowIso;
  }
  return { ...state, unread, handled: newestEntries(handled, (at) => at, HANDLED_LIMIT) };
}

/** Newest first. */
export function unreadTeammateMessages(
  unread: TeammateMessagesState["unread"],
): ReadonlyArray<TeammateMessage> {
  return Object.values(unread).toSorted((left, right) => right.at.localeCompare(left.at));
}

/** The count on the bell: a digit, or 9+. */
export function unreadBadgeLabel(count: number): string | null {
  if (count <= 0) return null;
  return count > 9 ? "9+" : String(count);
}

/** A thread was read up to `at`; a later arrival there makes it a candidate again. */
export function recordScan(
  state: TeammateMessagesState,
  candidate: ScanCandidate,
): TeammateMessagesState {
  const key = scanKey(candidate.environmentId, candidate.threadId);
  if ((state.scannedAt[key] ?? "") >= candidate.latestUserMessageAt) return state;
  return {
    ...state,
    scannedAt: newestEntries(
      { ...state.scannedAt, [key]: candidate.latestUserMessageAt },
      (at) => at,
      SCANNED_LIMIT,
    ),
  };
}

export type RoutedSenderTarget =
  | { readonly kind: "thread"; readonly environmentId: EnvironmentId; readonly threadId: ThreadId }
  | { readonly kind: "linear"; readonly url: string }
  | null;

/**
 * Where a routed comment's sender label leads: the sending thread when it is one of this
 * environment's (the Inbox forwarded it, or a reply came back to my own thread), else the comment
 * on Linear.
 */
export function routedSenderTarget(input: {
  readonly text: string;
  /** `linkedSender`, or this environment's `senderThreadId`. */
  readonly sender: { readonly environmentId: EnvironmentId; readonly threadId: ThreadId } | null;
  readonly environmentId: EnvironmentId;
  readonly senderThreadIsLocal: boolean;
}): RoutedSenderTarget {
  const comment = parseLinearComment(input.text);
  if (comment === null) return null;
  if (
    input.sender !== null &&
    input.sender.environmentId === input.environmentId &&
    input.senderThreadIsLocal
  ) {
    return {
      kind: "thread",
      environmentId: input.sender.environmentId,
      threadId: input.sender.threadId,
    };
  }
  return comment.url === null ? null : { kind: "linear", url: comment.url };
}
