import type {
  EnvironmentId,
  MessageId,
  OrchestrationThreadSearchMatch,
  ThreadId,
} from "@t3tools/contracts";

/** What the server's thread search is asked for: every routed comment's first words. */
export const TEAMMATE_MESSAGE_QUERY = "Linear comment";

// The first line of a routed comment: `[Linear comment <nonce> on <issue> from <sender>]`.
// The search snippet collapses newlines, so the body follows the header on the same line there.
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

/** A search hit that is a routed comment; null for any other match. */
export function teammateMessageFromMatch(
  environmentId: EnvironmentId,
  match: Pick<
    OrchestrationThreadSearchMatch,
    "threadId" | "source" | "snippet" | "messageCreatedAt" | "messageId"
  >,
): TeammateMessage | null {
  if (match.source !== "user" || match.messageCreatedAt === null) return null;
  const header = parseHeader(match.snippet);
  if (header === null) return null;
  const closing = header.rest.indexOf(closingMarker(header.nonce));
  return {
    nonce: header.nonce,
    issue: header.issue,
    sender: header.sender,
    environmentId,
    threadId: match.threadId,
    messageId: match.messageId ?? null,
    preview: (closing === -1 ? header.rest : header.rest.slice(0, closing)).trim(),
    at: match.messageCreatedAt,
  };
}

export interface TeammateMessagesState {
  /** Every routed comment seen and not yet handled, by nonce. */
  readonly unread: Readonly<Record<string, TeammateMessage>>;
  /** When each comment was opened or dismissed, by nonce, so a later search does not bring it back. */
  readonly handled: Readonly<Record<string, string>>;
}

export const EMPTY_TEAMMATE_MESSAGES: TeammateMessagesState = { unread: {}, handled: {} };

/** Handled marks kept; older ones are older than anything a search still returns in practice. */
const HANDLED_LIMIT = 500;
const UNREAD_LIMIT = 200;

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
 * Adds what a search found. A comment seen in two threads (the Inbox forwarded it) keeps the
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
  return { unread, handled: newestEntries(handled, (at) => at, HANDLED_LIMIT) };
}

/** Newest first. */
export function unreadTeammateMessages(
  state: TeammateMessagesState,
): ReadonlyArray<TeammateMessage> {
  return Object.values(state.unread).toSorted((left, right) => right.at.localeCompare(left.at));
}

/** The count on the bell: a digit, or 9+. */
export function unreadBadgeLabel(count: number): string | null {
  if (count <= 0) return null;
  return count > 9 ? "9+" : String(count);
}

/**
 * Changes whenever a message that the user did not write lands in one of these threads as the
 * user's (agents' messages and wakes do; a routed comment is one of them). Shells carry no
 * message text, so this is the cue to search again.
 */
export function agentMessageArrivalSignal(
  shells: ReadonlyArray<{
    readonly latestUserMessageAt: string | null;
    readonly latestUserAuthoredMessageAt?: string | null | undefined;
  }>,
): string {
  let latest = "";
  for (const shell of shells) {
    const at = shell.latestUserMessageAt;
    if (at === null || at === (shell.latestUserAuthoredMessageAt ?? null)) continue;
    if (at > latest) latest = at;
  }
  return latest;
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
