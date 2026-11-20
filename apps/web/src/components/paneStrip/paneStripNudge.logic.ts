import type { ProjectMoment, ThreadId } from "@t3tools/contracts";

import { momentLabel } from "../chat/timelineMoments.logic";

/** One thing that arrived in the project pane while it was off screen. */
export interface PaneStripArrival {
  readonly kind: "moment" | "inbox";
  readonly label: string;
  /** The moment's thread title, or the start of the Inbox agent's message. */
  readonly detail: string;
}

/** What the nudge has already seen, so only what arrives after it counts as new. */
export interface PaneStripNudgeWatch {
  /** The newest moment's time; undefined until the server first answers, null for none. */
  readonly newestMomentAt: number | null | undefined;
  /** The Inbox thread's latest message as last seen; undefined until its shell is known. */
  readonly inbox: { readonly threadId: ThreadId; readonly messageId: string | null } | undefined;
}

export const INITIAL_PANE_STRIP_NUDGE_WATCH: PaneStripNudgeWatch = {
  newestMomentAt: undefined,
  inbox: undefined,
};

/** The Inbox thread's latest message, and whether its agent is still writing. */
export interface PaneStripInboxLatest {
  readonly threadId: ThreadId;
  readonly running: boolean;
  readonly latestMessage: {
    readonly id: string;
    readonly role: string;
    readonly text: string;
  } | null;
}

export interface PaneStripNudgeInput {
  /** The project's moments, oldest first; null until the server answers. */
  readonly moments: ReadonlyArray<ProjectMoment> | null;
  /** The Inbox thread shown in the pane and its latest message; null when the pane has no Inbox. */
  readonly inbox: PaneStripInboxLatest | null;
  /** The open thread, whose news the reader is already looking at. */
  readonly openThreadId: ThreadId;
  readonly paneOnScreen: boolean;
}

const INBOX_DETAIL_LENGTH = 120;

/**
 * Advances the watch to what is there now and returns what arrived since. The first answer and a
 * new Inbox thread only set the watch, and nothing counts while the pane itself is on screen.
 */
export function watchPaneStripArrivals(
  watch: PaneStripNudgeWatch,
  input: PaneStripNudgeInput,
): { readonly watch: PaneStripNudgeWatch; readonly arrivals: ReadonlyArray<PaneStripArrival> } {
  const arrivals: PaneStripArrival[] = [];

  let newestMomentAt = watch.newestMomentAt;
  if (input.moments !== null) {
    const since = watch.newestMomentAt;
    newestMomentAt ??= null;
    for (const moment of input.moments) {
      const at = Date.parse(moment.at);
      if (!Number.isFinite(at)) continue;
      if (newestMomentAt === null || at > newestMomentAt) {
        newestMomentAt = at;
      }
      if (since === undefined || (since !== null && at <= since)) continue;
      // The Inbox's own moments repeat its messages, which nudge by themselves.
      if (moment.threadId === input.openThreadId || moment.threadId === input.inbox?.threadId) {
        continue;
      }
      arrivals.push({ kind: "moment", label: momentLabel(moment), detail: moment.threadTitle });
    }
  }

  let inbox = watch.inbox;
  if (input.inbox !== null) {
    const latest = input.inbox.latestMessage;
    const messageId = latest?.id ?? null;
    const known = watch.inbox !== undefined && watch.inbox.threadId === input.inbox.threadId;
    // A reply counts once its run ends, so the nudge shows it whole rather than its first words.
    const settled = !known || !input.inbox.running;
    if (known && settled && latest !== null && messageId !== watch.inbox?.messageId) {
      if (latest.role === "assistant") {
        arrivals.push({
          kind: "inbox",
          label: "Inbox replied",
          detail: latest.text.replace(/\s+/g, " ").trim().slice(0, INBOX_DETAIL_LENGTH),
        });
      }
    }
    if (settled && (!known || messageId !== watch.inbox?.messageId)) {
      inbox = { threadId: input.inbox.threadId, messageId };
    }
  }

  const next =
    newestMomentAt === watch.newestMomentAt && inbox === watch.inbox
      ? watch
      : { newestMomentAt, inbox };
  return { watch: next, arrivals: input.paneOnScreen ? [] : arrivals };
}

/** The one nudge on show: the latest arrival, and how many arrived since it first showed. */
export interface PaneStripNudgeShown {
  readonly latest: PaneStripArrival;
  readonly count: number;
}

export function addPaneStripArrivals(
  shown: PaneStripNudgeShown | null,
  arrivals: ReadonlyArray<PaneStripArrival>,
): PaneStripNudgeShown | null {
  const latest = arrivals.at(-1);
  if (latest === undefined) return shown;
  return { latest, count: (shown?.count ?? 0) + arrivals.length };
}
