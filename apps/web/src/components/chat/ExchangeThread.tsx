import type { ResponseContextRecord, ScopedThreadRef } from "@t3tools/contracts";
import { resolveUserMessagePresentation } from "@t3tools/client-runtime/user-message";
import { replaceComposerContextReferences } from "@t3tools/shared/composerContextReferences";
import { textAfterReLines, type ReLine } from "@t3tools/shared/replyMarkers";
import { MessagesSquareIcon } from "lucide-react";
import {
  createContext,
  use,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
  type ReactNode,
} from "react";
import { captureAssistantMessageOpening } from "~/lib/assistantTextSelection";
import { responseContextRecord } from "~/lib/composerContextRecords";
import { useStableCallback } from "~/hooks/useStableCallback";
import { observeResize } from "~/lib/observeResize";
import { cn } from "~/lib/utils";
import { useComposerDraftStore } from "../../composerDraftStore";
import { useClientSettings } from "../../hooks/useSettings";
import { readResponseSubagents } from "../../state/entities";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  deriveExchangeMap,
  messageClickOpensThread,
  reLineMatchText,
  reLineQuotesMessage,
  replyMarkersEnabled,
  sameExchangeStructure,
  shouldAttachThreadReply,
  threadExchangeKeys,
  threadLatestReplyRowId,
  threadRowIds,
  threadSummaryLabel,
  threadTriggerFocusSelectors,
  canRestoreFocusTo,
  type ExchangeMap,
  type ThreadTrigger,
} from "./exchangeThread.logic";
import type { MessagesTimelineRow } from "./MessagesTimeline.logic";
import { TimelineRowCtx } from "./timelineRowContext";

// Exported so another layer over the timeline opens, frosts and lines up like the thread view.
export const MOTION_MS = 240;
export const MOTION_EASING = "cubic-bezier(0.25, 0.8, 0.25, 1)";
/** The glass and the view's z-index; list layers stacked above it would paint over the frost. */
export const VIEW_Z_INDEX = 10;
export const GLASS_CLASS =
  "bg-card/60 backdrop-blur-(--glass-blur) backdrop-saturate-(--glass-saturation)";
// The view is not inside `.messages-timeline-scroll`, so it copies that list's lane padding from
// index.css: the content then sits where the list's does, beside the details card and preview player.
export const LIST_LANE_PADDING_CLASS =
  "scrollbar-gutter-both [--exchange-lane-pad:--spacing(3)] sm:[--exchange-lane-pad:--spacing(12)] [--exchange-lane-start:calc(var(--exchange-lane-pad)+var(--chat-lane-inset-start,0px)-var(--chat-timeline-gutter,0px))] [--exchange-lane-end:calc(var(--exchange-lane-pad)+var(--chat-lane-inset-end,0px)-var(--chat-timeline-gutter,0px))] in-data-[chat-canvas]:ps-(--exchange-lane-start) in-data-[chat-canvas]:pe-(--exchange-lane-end)";
/** A bubble click waits this long, so a double click that selects a word does not open the view. */
const BUBBLE_CLICK_DELAY_MS = 250;
/** Inside a bubble, clicks on these do their own thing. */
const BUBBLE_INTERACTIVE_SELECTOR = [
  "a[href]",
  "button",
  "input",
  "textarea",
  "select",
  "summary",
  "label",
  "audio",
  "video",
  "iframe",
  "[role=button]",
  "[role=link]",
  "[role=checkbox]",
  "[role=radio]",
  "[role=switch]",
  "[role=tab]",
  "[role=menuitem]",
  "[contenteditable]:not([contenteditable=false])",
  "[tabindex]:not([tabindex='-1'])",
  "[data-chat-markdown-question]",
].join(", ");

export interface ExchangeThreadContextValue {
  readonly map: ExchangeMap;
  readonly quotes: ReadonlyMap<string, string>;
  /** Each user message's `reLineMatchText`, by row. */
  readonly matchTexts: ReadonlyMap<string, string>;
  readonly markersEnabled: boolean;
  readonly bubbleOpensThread: boolean;
  readonly open: (trigger: ThreadTrigger) => void;
  readonly openFromBubble: (event: MouseEvent<HTMLElement>, rowId: string) => void;
}

/** Rows drawn inside the thread view already read in order, so they carry no markers. */
const InThreadViewCtx = createContext(false);

function messageQuote(message: MessagesTimelineRow & { kind: "message" }): string {
  const { text } = resolveUserMessagePresentation(message.message);
  return replaceComposerContextReferences(text, (reference) =>
    reference.kind === "response" ? "" : reference.label,
  )
    .replace(/\s+/g, " ")
    .trim();
}

function deriveStructure(identity: string, rows: ReadonlyArray<MessagesTimelineRow>) {
  const quotes = new Map<string, string>();
  const matchTexts = new Map<string, string>();
  for (const row of rows) {
    if (row.kind !== "message" || row.message.role !== "user") continue;
    const quote = messageQuote(row);
    quotes.set(row.id, quote);
    matchTexts.set(row.id, reLineMatchText(quote));
  }
  return { identity, rows, map: deriveExchangeMap(rows), quotes, matchTexts };
}

function hasTextSelection() {
  return document.getSelection()?.isCollapsed === false;
}

/** A plain click on the bubble itself: not a selection, a modified click or one of its controls. */
function isPlainBubbleClick(event: MouseEvent<HTMLElement>) {
  if (event.defaultPrevented || event.button !== 0) return false;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return false;
  if (!(event.target instanceof Element) || hasTextSelection()) return false;
  const control = event.target.closest(BUBBLE_INTERACTIVE_SELECTOR);
  if (control !== null && event.currentTarget.contains(control)) return false;
  // The bubble can hold controls drawn outside its edges, such as floating message actions.
  const rect = event.currentTarget.getBoundingClientRect();
  return (
    event.clientX >= rect.left &&
    event.clientX <= rect.right &&
    event.clientY >= rect.top &&
    event.clientY <= rect.bottom
  );
}

function timelineRowElement(viewport: HTMLElement, rowId: string): HTMLElement | null {
  for (const element of viewport.querySelectorAll<HTMLElement>(
    `[data-timeline-row-id="${CSS.escape(rowId)}"]`,
  )) {
    if (!element.closest("[data-exchange-thread-view]")) return element;
  }
  return null;
}

function listScrollNode(viewport: HTMLElement): HTMLElement | null {
  return viewport.querySelector<HTMLElement>(".messages-timeline-scroll");
}

function replyRecord(
  threadRef: ScopedThreadRef,
  row: MessagesTimelineRow | undefined,
): ResponseContextRecord | null {
  if (row?.kind !== "message" || row.message.streaming || !row.projectedItem) return null;
  const { message } = row;
  if (!message.text.trim()) return null;
  const itemId = row.projectedItem.sourceItemId;
  // Mirrors the reply button on an assistant message, so a reply from here reads the same.
  const source = [
    ...document.querySelectorAll<HTMLElement>("[data-assistant-citation-source]"),
  ].find((element) => element.dataset.assistantCitationSource === message.id);
  const opening = captureAssistantMessageOpening(source ?? null, textAfterReLines(message.text));
  if (!opening) return null;
  return responseContextRecord({
    citation: { version: 1, ...threadRef, messageId: message.id, ...opening },
    itemId,
    subagents: readResponseSubagents(threadRef, itemId),
  });
}

interface OpenThread {
  readonly identity: string;
  readonly rowId: string;
  readonly trigger: ThreadTrigger;
  readonly sources: ReadonlyMap<string, DOMRect>;
  /** Where the list was, since attaching the composer reply moves it to its end. */
  readonly listScrollTop: number | null;
  readonly session: number;
}

export interface ExchangeThreadState {
  readonly context: ExchangeThreadContextValue;
  readonly view: {
    readonly session: number;
    readonly rows: ReadonlyArray<MessagesTimelineRow>;
    readonly label: string;
    readonly sources: ReadonlyMap<string, DOMRect>;
    readonly listScrollTop: number | null;
    readonly trigger: ThreadTrigger;
    readonly closing: boolean;
    readonly close: () => void;
    readonly finishClose: () => void;
  } | null;
}

/**
 * Maps each timeline row to its exchange and owns the thread view: which exchange is open,
 * and the composer reply that a message sent from inside it carries.
 */
export function useExchangeThread(input: {
  readonly rows: ReadonlyArray<MessagesTimelineRow>;
  readonly identity: string;
  readonly viewport: HTMLElement | null;
  readonly threadRef: ScopedThreadRef | null;
  readonly onReplyToResponse: ((response: ResponseContextRecord) => boolean) | undefined;
  /** Find reads and scrolls the list itself, so it closes the thread view. */
  readonly suspended: boolean;
  /** What owns the composer instead of a new message; a change retries a refused reply. */
  readonly awaitingUser: string | null;
}): ExchangeThreadState {
  const { rows, identity, threadRef } = input;
  const [structure, setStructure] = useState(() => deriveStructure(identity, rows));
  let current = structure;
  if (structure.identity !== identity || !sameExchangeStructure(structure.rows, rows)) {
    current = deriveStructure(identity, rows);
    setStructure(current);
  }
  const { map, quotes, matchTexts } = current;
  const markersEnabled = useClientSettings(replyMarkersEnabled);
  const bubbleOpensThread = useClientSettings(messageClickOpensThread);

  const [opened, setOpened] = useState<OpenThread | null>(null);
  const [closing, setClosing] = useState(false);
  const rootKey =
    opened && opened.identity === identity && !input.suspended
      ? map.keyByRowId.get(opened.rowId)
      : undefined;
  if (opened && rootKey === undefined) {
    setOpened(null);
    setClosing(false);
  }
  const keys = rootKey === undefined ? [] : threadExchangeKeys(map, rootKey);
  const latestReplyRowId = threadLatestReplyRowId(map, keys);
  const latestReply = rows.find((row) => row.id === latestReplyRowId);
  const latestReplyReady =
    latestReply?.kind === "message" && !latestReply.message.streaming ? latestReply.id : null;

  // The reply this view attached, and what the composer held before it, to put back on close.
  const replyRef = useRef<{
    target: ScopedThreadRef;
    attachedId: string | null;
    previous: ResponseContextRecord | null;
    /** Until the first attach lands, it replaces a reply the composer already held. */
    replacesDraft: boolean;
    /** False while the open motion runs, since the reply banner moves the list. */
    ready: boolean;
  } | null>(null);
  const readDraftReply = (target: ScopedThreadRef) =>
    useComposerDraftStore.getState().getComposerDraft(target)?.replyTo ?? null;

  // Goes through the composer's own reply path, which refuses while a question or the
  // project picker owns the composer; a refusal is retried when that changes.
  const attachReply = useStableCallback((replyRowId: string | null, composerOwned: boolean) => {
    const reply = replyRef.current;
    // Asking while a question owns the composer would only warn that it is not ready.
    if (!reply || !reply.ready || composerOwned || replyRowId === null) return;
    const record = replyRecord(
      reply.target,
      rows.find((row) => row.id === replyRowId),
    );
    const attach = shouldAttachThreadReply({
      candidateId: record?.contextId ?? null,
      attachedId: reply.attachedId,
      draftReplyId: readDraftReply(reply.target)?.contextId ?? null,
      replacesDraft: reply.replacesDraft,
    });
    if (!record || !attach || input.onReplyToResponse?.(record) !== true) return;
    reply.attachedId = record.contextId;
    reply.replacesDraft = false;
  });

  const composerOwned = input.awaitingUser === "input";
  const attachLatestReply = useStableCallback(() => attachReply(latestReplyReady, composerOwned));

  // A pending bubble open, which any later pointer press, key press or open cancels.
  const pendingBubbleRef = useRef<(() => void) | null>(null);
  const open = useStableCallback((trigger: ThreadTrigger) => {
    pendingBubbleRef.current?.();
    const { rowId } = trigger;
    const key = map.keyByRowId.get(rowId);
    if (key === undefined) return;
    const sources = new Map<string, DOMRect>();
    const viewport = input.viewport;
    const list = viewport ? listScrollNode(viewport) : null;
    const listScrollTop =
      list && list.scrollHeight - list.scrollTop - list.clientHeight > 1 ? list.scrollTop : null;
    const ids = threadRowIds(map, threadExchangeKeys(map, key));
    if (viewport) {
      for (const id of ids) {
        const element = timelineRowElement(viewport, id);
        if (element) sources.set(id, element.getBoundingClientRect());
      }
    }
    if (threadRef) {
      const reply = {
        target: threadRef,
        attachedId: null,
        previous: readDraftReply(threadRef),
        replacesDraft: true,
        ready: false,
      };
      replyRef.current = reply;
      window.setTimeout(
        () => {
          if (replyRef.current !== reply) return;
          reply.ready = true;
          attachLatestReply();
        },
        prefersReducedMotion() ? 0 : MOTION_MS,
      );
    }
    setClosing(false);
    setOpened({
      identity,
      rowId,
      trigger,
      sources,
      listScrollTop,
      session: (opened?.session ?? 0) + 1,
    });
  });

  const cancelBubbleOpen = useStableCallback(() => pendingBubbleRef.current?.());
  const openFromBubble = useStableCallback((event: MouseEvent<HTMLElement>, rowId: string) => {
    cancelBubbleOpen();
    if (event.detail > 1 || !isPlainBubbleClick(event)) return;
    const timer = window.setTimeout(() => {
      cancel();
      if (!hasTextSelection()) open({ rowId, control: "bubble" });
    }, BUBBLE_CLICK_DELAY_MS);
    const cancel = () => {
      window.clearTimeout(timer);
      window.removeEventListener("pointerdown", cancel, true);
      window.removeEventListener("keydown", cancel, true);
      if (pendingBubbleRef.current === cancel) pendingBubbleRef.current = null;
    };
    window.addEventListener("pointerdown", cancel, true);
    window.addEventListener("keydown", cancel, true);
    pendingBubbleRef.current = cancel;
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a bubble open still waiting when the timeline unmounts must not fire
  useEffect(() => cancelBubbleOpen, [cancelBubbleOpen]);

  const restoreComposerReply = useStableCallback(() => {
    const reply = replyRef.current;
    replyRef.current = null;
    if (!reply || reply.attachedId === null) return;
    if (readDraftReply(reply.target)?.contextId === reply.attachedId) {
      useComposerDraftStore.getState().setReplyTo(reply.target, reply.previous);
    }
  });

  const isOpen = rootKey !== undefined;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a send consumes the composer's reply, and an answered question frees the composer; either way the next message from inside the thread must answer its newest reply
  useEffect(() => {
    if (isOpen) attachReply(latestReplyReady, composerOwned);
  }, [isOpen, latestReplyReady, composerOwned, attachReply]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a thread view that closes without its exit, such as on a thread switch, still hands the composer its reply back
  useEffect(() => {
    if (!isOpen) return;
    return () => restoreComposerReply();
  }, [isOpen, restoreComposerReply]);

  const close = useStableCallback(() => {
    restoreComposerReply();
    setClosing(true);
  });
  const finishClose = useStableCallback(() => {
    setOpened(null);
    setClosing(false);
  });

  const context: ExchangeThreadContextValue = {
    map,
    quotes,
    matchTexts,
    markersEnabled,
    bubbleOpensThread,
    open,
    openFromBubble,
  };
  if (!opened || rootKey === undefined) return { context, view: null };
  const shownIds = threadRowIds(map, keys);
  return {
    context,
    view: {
      session: opened.session,
      rows: rows.filter((row) => shownIds.has(row.id)),
      label: `Thread · ${threadSummaryLabel(map, keys)}`,
      sources: opened.sources,
      listScrollTop: opened.listScrollTop,
      trigger: opened.trigger,
      closing,
      close,
      finishClose,
    },
  };
}

function useExchange(rowId: string) {
  const inThreadView = use(InThreadViewCtx);
  const shared = use(TimelineRowCtx).exchangeThread;
  const ctx = inThreadView ? undefined : shared;
  const key = ctx?.map.keyByRowId.get(rowId);
  const exchange = key === undefined ? undefined : ctx?.map.exchanges.get(key);
  return { ctx, exchange };
}

/** A faded one-line quote above a reply that does not sit under the message it answers. */
export function ExchangeReplyMarker({ row }: { row: MessagesTimelineRow }) {
  const { ctx, exchange } = useExchange(row.id);
  if (!ctx || !ctx.markersEnabled || !exchange) return null;
  const quotedRowId = exchange.earlierRowIds[0];
  if (exchange.replyRowId !== row.id || quotedRowId === undefined) return null;
  const quote = ctx.quotes.get(quotedRowId) || "Earlier message";
  const more = exchange.earlierRowIds.length - 1;
  return (
    <button
      type="button"
      data-exchange-thread-control="reply-marker"
      data-exchange-control-row={row.id}
      aria-label={`View thread, replying to: ${quote}`}
      onClick={() => ctx.open({ rowId: row.id, control: "reply-marker" })}
      className="flex w-full min-w-0 cursor-pointer items-stretch gap-1.5 ps-2.5 pe-1 pt-0.5 text-start text-xs text-muted-foreground/70 transition-colors hover:text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring"
    >
      <span
        aria-hidden="true"
        className="mt-2 w-2.5 shrink-0 rounded-ss-md border-s border-t border-border"
      />
      <span className="min-w-0 truncate pb-1.5">{quote}</span>
      {more > 0 ? <span className="shrink-0 pb-1.5 tabular-nums">+{more}</span> : null}
    </button>
  );
}

/** "1 reply" under a message whose reply landed further down. */
export function ExchangeReplyLink({ row }: { row: MessagesTimelineRow }) {
  const { ctx, exchange } = useExchange(row.id);
  if (!ctx || !ctx.markersEnabled || !exchange) return null;
  if (exchange.replyRowId === null || !exchange.earlierRowIds.includes(row.id)) return null;
  return (
    <button
      type="button"
      data-exchange-thread-control="reply-link"
      data-exchange-control-row={row.id}
      onClick={() => ctx.open({ rowId: row.id, control: "reply-link" })}
      className="me-1 cursor-pointer rounded-sm text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
    >
      1 reply
    </button>
  );
}

/** Opens the thread of a row that belongs to an exchange with a user message; null otherwise. */
export function useExchangeThreadOpener(rowId: string): (() => void) | null {
  const { ctx, exchange } = useExchange(rowId);
  if (!ctx || !exchange || exchange.userRowIds.length === 0) return null;
  const { open } = ctx;
  return () => open({ rowId, control: "view-thread" });
}

/** The View thread button in a message's actions. */
export function ExchangeThreadButton({ rowId }: { rowId: string }) {
  const openThread = useExchangeThreadOpener(rowId);
  if (!openThread) return null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="xs"
            variant="ghost-muted"
            aria-label="View thread"
            data-exchange-thread-control="view-thread"
            data-exchange-control-row={rowId}
            onClick={openThread}
          />
        }
      >
        <MessagesSquareIcon className="size-3" />
      </TooltipTrigger>
      <TooltipPopup side="top">View thread</TooltipPopup>
    </Tooltip>
  );
}

/** What a message bubble spreads on itself so a click on it opens its exchange, when that is on. */
export function useExchangeBubble(rowId: string): {
  onClick?: (event: MouseEvent<HTMLElement>) => void;
  style?: CSSProperties;
} {
  const { ctx, exchange } = useExchange(rowId);
  if (!ctx?.bubbleOpensThread || !exchange || exchange.userRowIds.length === 0) return {};
  const { openFromBubble } = ctx;
  return {
    onClick: (event) => openFromBubble(event, rowId),
    style: { cursor: "pointer" },
  };
}

/**
 * An agent's opening "Re:" lines, drawn small and muted. A line that quotes one of its
 * exchange's messages opens the thread; any other line stays text.
 */
export function ExchangeReLines({ rowId, lines }: { rowId: string; lines: ReadonlyArray<ReLine> }) {
  const { ctx, exchange } = useExchange(rowId);
  const messageMatchTexts =
    ctx && exchange ? exchange.userRowIds.flatMap((id) => ctx.matchTexts.get(id) ?? []) : [];
  return (
    <div className="mb-1.5 flex max-w-full flex-col items-start text-start text-xs text-muted-foreground [overflow-wrap:anywhere]">
      {lines.map((line, index) =>
        ctx && reLineQuotesMessage(line.excerpt, messageMatchTexts) ? (
          <button
            // oxlint-disable-next-line react/no-array-index-key -- a streaming line keeps its slot as its text grows
            key={index}
            type="button"
            data-exchange-thread-control="re-line"
            data-exchange-control-row={rowId}
            onClick={() => ctx.open({ rowId, control: "re-line" })}
            className="max-w-full cursor-pointer rounded-sm text-start underline-offset-2 transition-colors hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-ring"
          >
            {line.text}
          </button>
        ) : (
          // oxlint-disable-next-line react/no-array-index-key -- a streaming line keeps its slot as its text grows
          <span key={index} className="max-w-full">
            {line.text}
          </span>
        ),
      )}
    </div>
  );
}

/** The control that opened the view, else its row, else the composer; any may have remounted. */
function focusThreadTrigger(viewport: HTMLElement, overlay: HTMLElement, trigger: ThreadTrigger) {
  const selectors = threadTriggerFocusSelectors(trigger);
  const outside = (selector: string | null) =>
    selector === null
      ? undefined
      : [...viewport.querySelectorAll<HTMLElement>(selector)].find((element) => {
          if (overlay.contains(element)) return false;
          const rect = element.getBoundingClientRect();
          return canRestoreFocusTo({
            connected: element.isConnected,
            shut: element.closest('[inert], [aria-hidden="true"]') !== null,
            visibility: getComputedStyle(element).visibility,
            width: rect.width,
            height: rect.height,
          });
        });
  const control = outside(selectors.control);
  if (control) return control.focus({ preventScroll: true });
  const row = outside(selectors.row);
  if (row) {
    if (!row.hasAttribute("tabindex")) {
      row.tabIndex = -1;
      row.addEventListener("blur", () => row.removeAttribute("tabindex"), { once: true });
    }
    return row.focus({ preventScroll: true });
  }
  document
    .querySelector<HTMLElement>('[data-testid="composer-editor"]')
    ?.focus({ preventScroll: true });
}

function prefersReducedMotion() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * The open exchange, drawn over the timeline in the same viewport. The virtualized list stays
 * mounted and untouched under the view's glass, so closing returns to the same scroll position.
 * Rows move from where the list showed them (FLIP) and fade in from below when it had them
 * virtualized away. Motion runs only on open and close: transform, opacity and the glass.
 */
export function ExchangeThreadView({
  view,
  viewport,
  bottomInset,
  topFadeEnabled,
  renderRow,
}: {
  readonly view: NonNullable<ExchangeThreadState["view"]>;
  readonly viewport: HTMLElement | null;
  readonly bottomInset: number;
  readonly topFadeEnabled: boolean;
  readonly renderRow: (row: MessagesTimelineRow) => ReactNode;
}) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const glassRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const layersRef = useRef<{ element: HTMLElement; hidden: Animation | null }[]>([]);
  const shownRowIdsRef = useRef<ReadonlySet<string>>(new Set());
  const { closing, close, finishClose } = view;

  const playEnter = useEffectEvent((overlay: HTMLElement): Animation[] => {
    if (!viewport) return [];
    const duration = prefersReducedMotion() ? 0 : MOTION_MS;
    const timing = { duration, easing: MOTION_EASING };
    // Making the list inert would drop focus from the control that opened the view; move it first.
    const active = document.activeElement;
    if (active === document.body || (active !== null && viewport.contains(active))) {
      overlay.focus({ preventScroll: true });
    }
    // The list stays visible under the view's glass, so the thread reads as a layer above the chat.
    const glass = glassRef.current;
    layersRef.current = [...viewport.children].flatMap((child) => {
      if (child === overlay || child === glass || !(child instanceof HTMLElement)) return [];
      child.setAttribute("inert", "");
      // Layers stacked above the glass, such as the timeline minimap, would stay sharp on top of it.
      const above = Number.parseInt(getComputedStyle(child).zIndex, 10) > VIEW_Z_INDEX;
      const hidden = above
        ? child.animate([{}, { opacity: 0 }], { ...timing, fill: "forwards" })
        : null;
      return [{ element: child, hidden }];
    });
    const moves: Animation[] = [];
    if (glass) moves.push(glass.animate([{ opacity: 0 }, { opacity: 1 }], timing));
    for (const element of overlay.querySelectorAll<HTMLElement>("[data-exchange-thread-row]")) {
      const rowId = element.dataset.exchangeThreadRow!;
      const source = view.sources.get(rowId);
      const target = element.getBoundingClientRect();
      if (source) {
        const listed = timelineRowElement(viewport, rowId);
        if (listed) moves.push(listed.animate([{ opacity: 0 }, { opacity: 0 }], timing));
        moves.push(
          element.animate(
            [{ transform: `translateY(${source.top - target.top}px)` }, { transform: "none" }],
            timing,
          ),
        );
      } else {
        moves.push(
          element.animate(
            [
              { opacity: 0, transform: "translateY(16px)" },
              { opacity: 1, transform: "none" },
            ],
            timing,
          ),
        );
      }
    }
    shownRowIdsRef.current = new Set(view.rows.map((row) => row.id));
    return moves;
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- frosts the list under the thread view and moves each row from where the list drew it, before the first paint
  useLayoutEffect(() => {
    const moves = overlayRef.current ? playEnter(overlayRef.current) : [];
    return () => {
      // A remount measures again, which a running move would skew.
      for (const animation of moves) animation.cancel();
      for (const { element, hidden } of layersRef.current) {
        hidden?.cancel();
        element.removeAttribute("inert");
      }
      layersRef.current = [];
    };
  }, []);

  const rowIdsKey = view.rows.map((row) => row.id).join("\n");
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a message sent from inside the thread, and its reply, slide into the open view and bring it to its end
  useLayoutEffect(() => {
    const overlay = overlayRef.current;
    if (!overlay || closing) return;
    const known = shownRowIdsRef.current;
    let joined = false;
    for (const element of overlay.querySelectorAll<HTMLElement>("[data-exchange-thread-row]")) {
      if (known.has(element.dataset.exchangeThreadRow!)) continue;
      joined = true;
      if (!prefersReducedMotion()) {
        element.animate(
          [
            { opacity: 0, transform: "translateY(8px)" },
            { opacity: 1, transform: "none" },
          ],
          { duration: MOTION_MS, easing: MOTION_EASING },
        );
      }
    }
    shownRowIdsRef.current = new Set(rowIdsKey.split("\n"));
    if (joined) overlay.scrollTo({ top: overlay.scrollHeight });
  }, [rowIdsKey, closing]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps a streaming reply's end in view while the reader stays at the end of the thread
  useEffect(() => {
    const overlay = overlayRef.current;
    const content = contentRef.current;
    if (!overlay || !content) return;
    let height = content.offsetHeight;
    return observeResize(content, () => {
      const next = content.offsetHeight;
      const atEnd =
        overlay.scrollHeight - overlay.scrollTop - overlay.clientHeight <= next - height + 8;
      if (next > height && atEnd) overlay.scrollTop = overlay.scrollHeight;
      height = next;
    });
  }, []);

  const restoreListScroll = useEffectEvent(() => {
    const list = viewport ? listScrollNode(viewport) : null;
    if (list && view.listScrollTop !== null) list.scrollTop = view.listScrollTop;
  });
  const playExit = useEffectEvent((overlay: HTMLElement, isCancelled: () => boolean) => {
    const duration = prefersReducedMotion() ? 0 : MOTION_MS;
    const timing = { duration, easing: MOTION_EASING, fill: "forwards" as const };
    for (const { element, hidden } of layersRef.current) {
      element.removeAttribute("inert");
      if (!hidden) continue;
      hidden.cancel();
      // An empty keyframe is the layer's own CSS opacity, so a hover-only minimap returns hidden.
      element.animate([{ opacity: 0 }, {}], { duration, easing: MOTION_EASING });
    }
    layersRef.current = [];
    const clearing = glassRef.current?.animate([{ opacity: 1 }, { opacity: 0 }], timing);
    for (const element of overlay.querySelectorAll<HTMLElement>("[data-exchange-thread-row]")) {
      const rowId = element.dataset.exchangeThreadRow!;
      const listed = viewport ? timelineRowElement(viewport, rowId) : null;
      const current = element.getBoundingClientRect();
      if (listed) {
        const target = listed.getBoundingClientRect();
        listed.animate([{ opacity: 0 }, { opacity: 0 }], { duration });
        element.animate(
          [{ transform: "none" }, { transform: `translateY(${target.top - current.top}px)` }],
          timing,
        );
      } else {
        element.animate(
          [
            { opacity: 1, transform: "none" },
            { opacity: 0, transform: "translateY(16px)" },
          ],
          timing,
        );
      }
    }
    void Promise.allSettled([clearing?.finished]).then(() => {
      if (isCancelled()) return;
      const focusInView =
        document.activeElement === document.body || overlay.contains(document.activeElement);
      if (focusInView && viewport) focusThreadTrigger(viewport, overlay, view.trigger);
      finishClose();
    });
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- moves each row back to where the list shows it and clears the glass, then unmounts
  useEffect(() => {
    const overlay = overlayRef.current;
    if (!closing || !overlay) return;
    let cancelled = false;
    // Closing hands the composer its reply back; the list settles its inset a frame later,
    // then renders the rows at the restored position a frame after that.
    let frame = 0;
    const afterFrames = (count: number, run: () => void) => {
      frame = requestAnimationFrame(() => {
        if (cancelled) return;
        if (count > 1) afterFrames(count - 1, run);
        else run();
      });
    };
    afterFrames(2, () => {
      restoreListScroll();
      afterFrames(2, () => playExit(overlay, () => cancelled));
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
    };
  }, [closing]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Escape closes the thread view from anywhere in the chat, unless something else handled it
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
      event.preventDefault();
      close();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [close]);

  const onBackdropClick = (event: MouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (target.closest("[data-timeline-row-id]")) return;
    if (document.getSelection()?.isCollapsed === false) return;
    close();
  };

  return (
    <InThreadViewCtx value>
      {/* A sibling of the scroller, so opening and closing fade it by opacity without animating the blur. */}
      <div
        ref={glassRef}
        aria-hidden
        className={cn("pointer-events-none absolute inset-0 z-10", GLASS_CLASS)}
      />
      <div
        ref={overlayRef}
        data-exchange-thread-view=""
        role="region"
        aria-label={view.label}
        tabIndex={-1}
        className={cn(
          "absolute inset-0 z-10 overflow-y-auto overscroll-y-contain outline-none [overflow-anchor:none]",
          LIST_LANE_PADDING_CLASS,
        )}
        onClick={onBackdropClick}
      >
        <div ref={contentRef} className="flex min-h-full flex-col">
          {topFadeEnabled ? (
            <div className="h-[var(--workspace-titlebar-scroll-fade-height)] shrink-0" />
          ) : null}
          <div
            className="flex flex-1 flex-col justify-end pt-4"
            style={{ paddingBottom: bottomInset + 16 }}
          >
            {view.rows.map((row) => (
              <div key={row.id} data-exchange-thread-row={row.id}>
                {renderRow(row)}
              </div>
            ))}
          </div>
        </div>
      </div>
    </InThreadViewCtx>
  );
}
