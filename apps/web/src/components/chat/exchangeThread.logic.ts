import type { ClientSettings } from "@t3tools/contracts";
import { isResponseContextRecord } from "~/lib/composerContextRecords";
import type { ChatMessage } from "../../types";

/** The fields of a timeline row the exchange map reads; `MessagesTimelineRow` satisfies it. */
export interface ExchangeRow {
  readonly id: string;
  readonly kind: string;
  readonly message?: Pick<ChatMessage, "id" | "role" | "runId" | "context">;
}

/** One user-to-agent exchange: the user messages a run consumed and that run's reply. */
export interface Exchange {
  readonly key: string;
  readonly userRowIds: ReadonlyArray<string>;
  /** The run's assistant message rows, in timeline order. */
  readonly replyRowIds: ReadonlyArray<string>;
  /** The first reply row after the exchange's last user message. */
  readonly replyRowId: string | null;
  /** User rows the reply does not sit directly under; empty when the exchange reads in order. */
  readonly earlierRowIds: ReadonlyArray<string>;
  readonly assistantMessageIds: ReadonlyArray<string>;
  /** Assistant messages the exchange's user messages reply to, through a response citation. */
  readonly citedMessageIds: ReadonlyArray<string>;
}

export interface ExchangeMap {
  /** In timeline order of each exchange's first row. */
  readonly exchanges: ReadonlyMap<string, Exchange>;
  /** Message and assistant-meta rows to their exchange. */
  readonly keyByRowId: ReadonlyMap<string, string>;
}

interface ExchangeDraft {
  userRowIds: string[];
  replyRowIds: string[];
  assistantMessageIds: string[];
  citedMessageIds: string[];
}

function isConversationMessage(row: ExchangeRow): boolean {
  return row.kind === "message" && row.message !== undefined && row.message.role !== "system";
}

function citedResponseIds(message: NonNullable<ExchangeRow["message"]>): string[] {
  return (message.context?.records ?? []).flatMap((record) =>
    isResponseContextRecord(record) ? [record.citation.messageId] : [],
  );
}

/**
 * Groups message rows by the run that consumed them. A run's `userMessageId` and every steer
 * or promoted queued message carry its run id, so the run id is the exchange. A runless
 * (imported or not yet committed) reply belongs to the runless user message before it, unless
 * a message with a run came in between.
 */
export function deriveExchangeMap(rows: ReadonlyArray<ExchangeRow>): ExchangeMap {
  const drafts = new Map<string, ExchangeDraft>();
  const keyByRowId = new Map<string, string>();
  let runlessUserKey: string | null = null;
  const keyByMessageId = new Map<string, string>();
  const draftFor = (key: string) => {
    let draft = drafts.get(key);
    if (!draft) {
      draft = { userRowIds: [], replyRowIds: [], assistantMessageIds: [], citedMessageIds: [] };
      drafts.set(key, draft);
    }
    return draft;
  };

  for (const row of rows) {
    const message = row.message;
    if (message === undefined || message.role === "system") continue;
    if (row.kind !== "message" && row.kind !== "assistant-meta") continue;
    const key: string =
      message.runId ??
      (message.role === "user"
        ? `message:${message.id}`
        : (keyByMessageId.get(message.id) ?? runlessUserKey ?? `message:${message.id}`));
    if (message.runId !== null) runlessUserKey = null;
    else if (message.role === "user") runlessUserKey = key;
    keyByMessageId.set(message.id, key);
    keyByRowId.set(row.id, key);
    if (row.kind !== "message") continue;
    const draft = draftFor(key);
    if (message.role === "user") {
      draft.userRowIds.push(row.id);
      draft.citedMessageIds.push(...citedResponseIds(message));
    } else {
      draft.replyRowIds.push(row.id);
      draft.assistantMessageIds.push(message.id);
    }
  }

  const indexById = new Map(rows.map((row, index) => [row.id, index] as const));
  const exchanges = new Map<string, Exchange>();
  for (const [key, draft] of drafts) {
    const lastUserIndex = indexById.get(draft.userRowIds.at(-1) ?? "") ?? -1;
    const replyRowId =
      draft.userRowIds.length === 0
        ? null
        : (draft.replyRowIds.find((id) => (indexById.get(id) ?? -1) > lastUserIndex) ?? null);
    exchanges.set(key, {
      key,
      userRowIds: draft.userRowIds,
      replyRowIds: draft.replyRowIds,
      replyRowId,
      earlierRowIds:
        replyRowId === null ? [] : earlierUserRows(rows, indexById, keyByRowId, key, replyRowId),
      assistantMessageIds: draft.assistantMessageIds,
      citedMessageIds: draft.citedMessageIds,
    });
  }
  return { exchanges, keyByRowId };
}

/**
 * The reply sits directly under its messages when they are back to back and only the run's own
 * work separates the last of them from it. Every other user row of the exchange is "earlier".
 */
function earlierUserRows(
  rows: ReadonlyArray<ExchangeRow>,
  indexById: ReadonlyMap<string, number>,
  keyByRowId: ReadonlyMap<string, string>,
  key: string,
  replyRowId: string,
): string[] {
  const isOwnUserRow = (row: ExchangeRow | undefined) =>
    row !== undefined &&
    isConversationMessage(row) &&
    row.message?.role === "user" &&
    keyByRowId.get(row.id) === key;
  let index = (indexById.get(replyRowId) ?? 0) - 1;
  while (index >= 0 && !isConversationMessage(rows[index]!)) index -= 1;
  const direct = new Set<string>();
  while (isOwnUserRow(rows[index])) {
    direct.add(rows[index]!.id);
    index -= 1;
  }
  return rows.flatMap((row) => (isOwnUserRow(row) && !direct.has(row.id) ? [row.id] : []));
}

/** The exchanges linked to `rootKey` through reply citations, in either direction. */
export function threadExchangeKeys(map: ExchangeMap, rootKey: string): string[] {
  if (!map.exchanges.has(rootKey)) return [];
  const keyByAssistantMessageId = new Map<string, string>();
  for (const exchange of map.exchanges.values()) {
    for (const id of exchange.assistantMessageIds) keyByAssistantMessageId.set(id, exchange.key);
  }
  const linked = new Map<string, Set<string>>();
  const link = (from: string, to: string) => {
    if (!linked.has(from)) linked.set(from, new Set());
    linked.get(from)!.add(to);
  };
  for (const exchange of map.exchanges.values()) {
    for (const messageId of exchange.citedMessageIds) {
      const cited = keyByAssistantMessageId.get(messageId);
      if (cited === undefined || cited === exchange.key) continue;
      link(exchange.key, cited);
      link(cited, exchange.key);
    }
  }
  const members = new Set([rootKey]);
  const pending = [rootKey];
  while (pending.length > 0) {
    for (const next of linked.get(pending.pop()!) ?? []) {
      if (members.has(next)) continue;
      members.add(next);
      pending.push(next);
    }
  }
  return [...map.exchanges.keys()].filter((key) => members.has(key));
}

/** The rows a thread view shows: each exchange's user messages and its reply, with its meta row. */
export function threadRowIds(map: ExchangeMap, keys: ReadonlyArray<string>): Set<string> {
  const members = new Set(keys);
  const ids = new Set<string>();
  for (const [rowId, key] of map.keyByRowId) {
    if (members.has(key)) ids.add(rowId);
  }
  return ids;
}

export function threadSummaryLabel(map: ExchangeMap, keys: ReadonlyArray<string>): string {
  let messages = 0;
  let replies = 0;
  for (const key of keys) {
    const exchange = map.exchanges.get(key);
    if (!exchange) continue;
    messages += exchange.userRowIds.length;
    if (exchange.replyRowIds.length > 0) replies += 1;
  }
  const count = (value: number, one: string, many: string) =>
    `${value} ${value === 1 ? one : many}`;
  return `${count(messages, "message", "messages")}, ${count(replies, "reply", "replies")}`;
}

/** The newest reply message in the thread, which a reply from inside the thread answers. */
export function threadLatestReplyRowId(
  map: ExchangeMap,
  keys: ReadonlyArray<string>,
): string | null {
  for (const key of keys.toReversed()) {
    const replyRowId = map.exchanges.get(key)?.replyRowIds.at(-1);
    if (replyRowId !== undefined) return replyRowId;
  }
  return null;
}

/**
 * Whether the open thread view should point the composer's reply at the thread's newest reply.
 * A reply the user picked themselves stays, except when the view first opens over it.
 */
export function shouldAttachThreadReply(input: {
  readonly candidateId: string | null;
  /** The reply the view last attached and the composer accepted. */
  readonly attachedId: string | null;
  readonly draftReplyId: string | null;
  readonly replacesDraft: boolean;
}): boolean {
  if (input.candidateId === null || input.draftReplyId === input.candidateId) return false;
  return (
    input.replacesDraft || input.draftReplyId === null || input.draftReplyId === input.attachedId
  );
}

export type ThreadTriggerControl = "reply-link" | "reply-marker" | "view-thread";

/** What opened the thread view, by identity, since the list can remount the control itself. */
export interface ThreadTrigger {
  readonly rowId: string;
  readonly control: ThreadTriggerControl;
}

const attributeValue = (value: string) => `"${value.replace(/["\\]/g, "\\$&")}"`;

/** Where focus goes back on close, in order: the control that opened the view, then its row. */
export function threadTriggerFocusSelectors(trigger: ThreadTrigger): string[] {
  const rowId = attributeValue(trigger.rowId);
  return [
    `[data-exchange-thread-control=${attributeValue(trigger.control)}][data-exchange-control-row=${rowId}]`,
    `[data-timeline-row-id=${rowId}]`,
  ];
}

/** What focus restore reads from an element; a duplicate or collapsed copy of a control fails it. */
export interface FocusCandidate {
  readonly connected: boolean;
  /** Inside an inert or aria-hidden subtree. */
  readonly shut: boolean;
  readonly visibility: string;
  readonly width: number;
  readonly height: number;
}

export function canRestoreFocusTo(candidate: FocusCandidate): boolean {
  return (
    candidate.connected &&
    !candidate.shut &&
    candidate.visibility === "visible" &&
    candidate.width > 0 &&
    candidate.height > 0
  );
}

/** Everything the exchange map reads from a row, so streamed text keeps the previous map. */
export function sameExchangeStructure(
  previous: ReadonlyArray<ExchangeRow>,
  next: ReadonlyArray<ExchangeRow>,
): boolean {
  if (previous === next) return true;
  if (previous.length !== next.length) return false;
  for (let index = 0; index < next.length; index += 1) {
    const a = previous[index]!;
    const b = next[index]!;
    if (a.id !== b.id || a.kind !== b.kind) return false;
    if (a.message === b.message) continue;
    if (
      a.message?.id !== b.message?.id ||
      a.message?.role !== b.message?.role ||
      a.message?.runId !== b.message?.runId ||
      a.message?.context !== b.message?.context
    ) {
      return false;
    }
  }
  return true;
}

// Stored in the free-form `threadDetailsItems` record, so no settings schema change.
const REPLY_MARKERS_SETTING_KEY = "replyMarkers";

export function replyMarkersEnabled(settings: Pick<ClientSettings, "threadDetailsItems">) {
  return settings.threadDetailsItems[REPLY_MARKERS_SETTING_KEY] ?? true;
}

export function setReplyMarkersEnabled(
  settings: Pick<ClientSettings, "threadDetailsItems">,
  enabled: boolean,
): ClientSettings["threadDetailsItems"] {
  const { [REPLY_MARKERS_SETTING_KEY]: _previous, ...rest } = settings.threadDetailsItems;
  return enabled ? rest : { ...rest, [REPLY_MARKERS_SETTING_KEY]: false };
}
