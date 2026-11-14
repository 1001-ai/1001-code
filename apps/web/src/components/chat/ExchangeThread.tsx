import type { ResponseContextRecord, ScopedThreadRef } from "@t3tools/contracts";
import { resolveUserMessagePresentation } from "@t3tools/client-runtime/user-message";
import { replaceComposerContextReferences } from "@t3tools/shared/composerContextReferences";
import { MessageSquareQuoteIcon } from "lucide-react";
import {
  createContext,
  use,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";
import { captureAssistantMessageOpening } from "~/lib/assistantTextSelection";
import { responseContextRecord } from "~/lib/composerContextRecords";
import { useStableCallback } from "~/hooks/useStableCallback";
import { observeResize } from "~/lib/observeResize";
import { useComposerDraftStore } from "../../composerDraftStore";
import { useClientSettings } from "../../hooks/useSettings";
import { readResponseSubagents } from "../../state/entities";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  deriveExchangeMap,
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

const MOTION_MS = 240;
const MOTION_EASING = "cubic-bezier(0.25, 0.8, 0.25, 1)";

export interface ExchangeThreadContextValue {
  readonly map: ExchangeMap;
  readonly quotes: ReadonlyMap<string, string>;
  readonly markersEnabled: boolean;
  readonly open: (trigger: ThreadTrigger) => void;
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
  for (const row of rows) {
    if (row.kind === "message" && row.message.role === "user")
      quotes.set(row.id, messageQuote(row));
  }
  return { identity, rows, map: deriveExchangeMap(rows), quotes };
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
  const opening = captureAssistantMessageOpening(source ?? null, message.text);
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
  const { map, quotes } = current;
  const markersEnabled = useClientSettings(replyMarkersEnabled);

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

  const open = useStableCallback((trigger: ThreadTrigger) => {
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
    markersEnabled,
    open,
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

/** The hover action that opens a message's exchange in the thread view. */
export function ExchangeViewThreadButton({ rowId }: { rowId: string }) {
  const { ctx, exchange } = useExchange(rowId);
  if (!ctx || !exchange || exchange.userRowIds.length === 0) return null;
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
            onClick={() => ctx.open({ rowId, control: "view-thread" })}
          />
        }
      >
        <MessageSquareQuoteIcon className="size-3" />
      </TooltipTrigger>
      <TooltipPopup side="top">View thread</TooltipPopup>
    </Tooltip>
  );
}

/** The control that opened the view, else its row, else the composer; any may have remounted. */
function focusThreadTrigger(viewport: HTMLElement, overlay: HTMLElement, trigger: ThreadTrigger) {
  const [controlSelector, rowSelector] = threadTriggerFocusSelectors(trigger);
  const outside = (selector: string | undefined) =>
    selector === undefined
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
  const control = outside(controlSelector);
  if (control) return control.focus({ preventScroll: true });
  const row = outside(rowSelector);
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
 * mounted and untouched underneath, faded out, so closing returns to the same scroll position.
 * Rows move from where the list showed them (FLIP) and fade in from below when it had them
 * virtualized away. Motion runs only on open and close, with transform and opacity.
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
  const headerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const layersRef = useRef<{ element: HTMLElement; animation: Animation }[]>([]);
  const shownRowIdsRef = useRef<ReadonlySet<string>>(new Set());
  const { closing, close, finishClose } = view;

  const playEnter = useEffectEvent((overlay: HTMLElement): Animation[] => {
    if (!viewport) return [];
    const duration = prefersReducedMotion() ? 0 : MOTION_MS;
    const timing = { duration, easing: MOTION_EASING };
    layersRef.current = [...viewport.children].flatMap((child) => {
      if (child === overlay || !(child instanceof HTMLElement)) return [];
      child.setAttribute("inert", "");
      const animation = child.animate(
        [
          { opacity: 1, visibility: "visible" },
          { opacity: 0, visibility: "hidden" },
        ],
        { ...timing, fill: "forwards" },
      );
      return [{ element: child, animation }];
    });
    const moves: Animation[] = [];
    const header = headerRef.current?.animate(
      [
        { opacity: 0, transform: "translateY(-4px)" },
        { opacity: 1, transform: "none" },
      ],
      timing,
    );
    if (header) moves.push(header);
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
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- fades the list under the thread view and moves each row from where the list drew it, before the first paint
  useLayoutEffect(() => {
    const moves = overlayRef.current ? playEnter(overlayRef.current) : [];
    return () => {
      // A remount measures again, which a running move would skew.
      for (const animation of moves) animation.cancel();
      for (const { element, animation } of layersRef.current) {
        animation.cancel();
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
    const fadeIns: Animation[] = [];
    for (const { element, animation } of layersRef.current) {
      animation.cancel();
      element.removeAttribute("inert");
      fadeIns.push(
        element.animate([{ opacity: 0 }, { opacity: 1 }], { duration, easing: MOTION_EASING }),
      );
    }
    layersRef.current = [];
    headerRef.current?.animate([{ opacity: 1 }, { opacity: 0 }], timing);
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
    void Promise.allSettled(fadeIns.map((animation) => animation.finished)).then(() => {
      if (isCancelled()) return;
      const focusInView =
        document.activeElement === document.body || overlay.contains(document.activeElement);
      if (focusInView && viewport) focusThreadTrigger(viewport, overlay, view.trigger);
      finishClose();
    });
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- moves each row back to where the list shows it and fades the list in, then unmounts
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
    // Row frames span the viewport; only the content lane counts as the messages.
    if (
      target.closest("[data-timeline-row-id], [data-exchange-thread-header] .chat-content-lane")
    ) {
      return;
    }
    if (document.getSelection()?.isCollapsed === false) return;
    close();
  };

  return (
    <InThreadViewCtx value>
      <div
        ref={overlayRef}
        data-exchange-thread-view=""
        role="region"
        aria-label={view.label}
        className="absolute inset-0 z-10 overflow-y-auto overscroll-y-contain [overflow-anchor:none]"
        onClick={onBackdropClick}
      >
        <div ref={contentRef} className="flex min-h-full flex-col">
          <div
            ref={headerRef}
            data-exchange-thread-header=""
            className="messages-timeline-row-frame sticky top-0 z-10 bg-background"
          >
            {topFadeEnabled ? (
              <div className="h-[var(--workspace-titlebar-scroll-fade-height)]" />
            ) : null}
            <div className="chat-content-lane flex items-center justify-between gap-3 border-b border-border/60 py-1.5 ps-1">
              <p className="min-w-0 truncate text-xs text-muted-foreground tabular-nums">
                {view.label}
              </p>
              <Button type="button" size="xs" variant="ghost" onClick={close}>
                Done
              </Button>
            </div>
          </div>
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
