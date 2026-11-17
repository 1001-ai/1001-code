import type { ScopedThreadRef } from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";
import { useStableCallback } from "~/hooks/useStableCallback";
import { resolveAssistantCitationRange } from "~/lib/assistantTextSelection";
import { Popover, PopoverPopup } from "../ui/popover";
import { ReplyAnnotationCommentBox } from "./ReplyAnnotationCommentBox";
import {
  editReplyAnnotation,
  removeReplyAnnotation,
  setReplyAnnotationComment,
  useEditingReplyAnnotationId,
  useThreadReplyAnnotations,
} from "./replyAnnotations";

const HIGHLIGHT = "reply-annotation";
const HIGHLIGHT_STYLE = `::highlight(${HIGHLIGHT}){background-color:color-mix(in oklab,var(--info) 30%,transparent)}`;
const MARKER_SIZE = 24;

// Side chats and the thread view each mount a timeline; they share one highlight.
const rangesByOverlay = new Map<symbol, ReadonlyArray<Range>>();
function publishRanges(owner: symbol, ranges: ReadonlyArray<Range> | null) {
  if (ranges) rangesByOverlay.set(owner, ranges);
  else rangesByOverlay.delete(owner);
  if (typeof CSS === "undefined" || !CSS.highlights || typeof Highlight === "undefined") return;
  const all = [...rangesByOverlay.values()].flat();
  if (all.length > 0) CSS.highlights.set(HIGHLIGHT, new Highlight(...all));
  else CSS.highlights.delete(HIGHLIGHT);
}

// The thread view draws its own copy of an exchange over the list and marks the rest of the
// timeline inert, so only list copies get markers; a click on a thread copy's highlight still works.
type QuoteCopy = "list" | "thread" | "covered";

interface Placement {
  readonly id: string;
  readonly range: Range;
  readonly copy: QuoteCopy;
  /** Null while the quote is out of view, or is not a list copy. */
  readonly marker: { readonly top: number; readonly left: number } | null;
}

function samePlacements(left: ReadonlyArray<Placement>, right: ReadonlyArray<Placement>) {
  return (
    left.length === right.length &&
    left.every((placement, index) => {
      const other = right[index]!;
      return (
        placement.id === other.id &&
        placement.range === other.range &&
        placement.copy === other.copy &&
        placement.marker?.top === other.marker?.top &&
        placement.marker?.left === other.marker?.left
      );
    })
  );
}

/** Highlights the drafted annotations in a timeline, with a numbered marker that opens each comment. */
export function ReplyAnnotationsOverlay({
  viewport,
  threadRef,
}: {
  viewport: HTMLElement | null;
  threadRef: ScopedThreadRef;
}) {
  const annotations = useThreadReplyAnnotations(threadRef);
  const editingId = useEditingReplyAnnotationId();
  const [placements, setPlacements] = useState<ReadonlyArray<Placement>>([]);
  const draftRef = useRef<{ id: string; comment: string } | null>(null);
  const markersRef = useRef<HTMLDivElement>(null);
  const readAnnotations = useStableCallback(() => annotations);
  // A comment never moves a quote, so only a changed range re-runs the measuring effect.
  const rangeKey = annotations
    .map(({ id, citation }) => `${id}:${citation.messageId}:${citation.start}:${citation.end}`)
    .join("|");

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- measures quote ranges in the virtualized timeline DOM, which React does not own, as it scrolls and re-renders
  useEffect(() => {
    if (!viewport || rangeKey.length === 0) return;
    const owner = Symbol("reply-annotations");
    let resolved: Array<{ id: string; range: Range; source: HTMLElement; copy: QuoteCopy }> = [];
    let stale = true;
    let frame = 0;
    const resolve = () => {
      const sources = [
        ...viewport.querySelectorAll<HTMLElement>("[data-assistant-citation-source]"),
      ];
      const threadView = viewport.querySelector<HTMLElement>("[data-exchange-thread-view]");
      resolved = readAnnotations().flatMap(({ id, citation }) => {
        const matches = sources.filter(
          (element) =>
            element.dataset.assistantCitationSource === citation.messageId &&
            element.dataset.assistantCitationEnvironment === citation.environmentId &&
            element.dataset.assistantCitationThread === citation.threadId,
        );
        const source = matches.find((element) => threadView?.contains(element)) ?? matches[0];
        const range = source ? resolveAssistantCitationRange(source, citation) : null;
        if (!source || !range) return [];
        const inThreadView = threadView?.contains(source) ?? false;
        const copy: QuoteCopy = threadView ? (inThreadView ? "thread" : "covered") : "list";
        return [{ id, range, source, copy }];
      });
      publishRanges(
        owner,
        resolved.map((entry) => entry.range),
      );
    };
    const place = () => {
      frame = 0;
      if (stale) {
        stale = false;
        resolve();
      }
      const bounds = viewport.getBoundingClientRect();
      const next = resolved.map(({ id, range, source, copy }): Placement => {
        const line = range.getClientRects()[0];
        const visible =
          copy === "list" && line && line.bottom > bounds.top && line.top < bounds.bottom;
        return {
          id,
          range,
          copy,
          marker: visible
            ? {
                top: Math.round(line.top - bounds.top + line.height / 2 - MARKER_SIZE / 2),
                left: Math.round(
                  Math.max(8, source.getBoundingClientRect().left - bounds.left - MARKER_SIZE - 12),
                ),
              }
            : null,
        };
      });
      setPlacements((previous) => (samePlacements(previous, next) ? previous : next));
    };
    const schedule = (reresolve: boolean) => {
      if (reresolve) stale = true;
      if (frame === 0) frame = requestAnimationFrame(place);
    };
    const reposition = () => schedule(false);
    // The markers render inside the viewport; their own updates must not trigger a re-measure.
    const mutations = new MutationObserver((records) => {
      if (records.some((record) => !markersRef.current?.contains(record.target))) schedule(true);
    });
    mutations.observe(viewport, { childList: true, subtree: true, characterData: true });
    viewport.addEventListener("scroll", reposition, { capture: true, passive: true });
    window.addEventListener("resize", reposition);
    // A click on highlighted text opens its comment, unless it ended a text selection.
    const openFromHighlight = (event: MouseEvent) => {
      if (window.getSelection()?.isCollapsed === false) return;
      const hit = resolved.find(
        ({ range, copy }) =>
          copy !== "covered" &&
          Array.from(range.getClientRects()).some(
            (rect) =>
              event.clientX >= rect.left &&
              event.clientX <= rect.right &&
              event.clientY >= rect.top &&
              event.clientY <= rect.bottom,
          ),
      );
      if (hit) editReplyAnnotation(hit.id);
    };
    viewport.addEventListener("click", openFromHighlight);
    schedule(true);
    return () => {
      cancelAnimationFrame(frame);
      mutations.disconnect();
      viewport.removeEventListener("scroll", reposition, { capture: true });
      window.removeEventListener("resize", reposition);
      viewport.removeEventListener("click", openFromHighlight);
      publishRanges(owner, null);
    };
  }, [rangeKey, readAnnotations, viewport]);

  if (annotations.length === 0) return null;
  const annotationsById = new Map(annotations.map((annotation) => [annotation.id, annotation]));
  const editing = placements.find((placement) => placement.id === editingId) ?? null;
  const editingAnnotation = editing ? annotationsById.get(editing.id) : undefined;
  const closeEditing = (save: boolean) => {
    const draft = draftRef.current;
    if (save && draft && draft.id === editingId) setReplyAnnotationComment(draft.id, draft.comment);
    draftRef.current = null;
    editReplyAnnotation(null);
  };

  // Markers stay inside the timeline, under the thread view's glass; the comment box is a popover.
  return (
    <>
      <div ref={markersRef} className="pointer-events-none absolute inset-0 z-[1] overflow-hidden">
        {placements.map(({ id, marker }) => {
          const annotation = annotationsById.get(id);
          if (!annotation || !marker) return null;
          return (
            <button
              key={id}
              type="button"
              aria-label={`Annotation ${annotation.number}${annotation.citation.comment ? `: ${annotation.citation.comment}` : ""}`}
              aria-expanded={id === editingId}
              className="pointer-events-auto absolute flex size-6 items-center justify-center rounded-full rounded-br-sm bg-info font-semibold text-white text-xs shadow-sm focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-white"
              style={{ top: marker.top, left: marker.left }}
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => {
                const wasOpen = id === editingId;
                closeEditing(true);
                if (!wasOpen) editReplyAnnotation(id);
              }}
            >
              {annotation.number}
            </button>
          );
        })}
      </div>
      <style>{HIGHLIGHT_STYLE}</style>
      <Popover
        open={editing !== null && editingAnnotation !== undefined}
        onOpenChange={(open, details) => {
          if (open) return;
          // A marker click is handled by the marker, which saves before it switches.
          const target = details.event.target;
          if (target instanceof Node && markersRef.current?.contains(target)) return;
          closeEditing(details.reason !== "escape-key");
        }}
      >
        {editing && editingAnnotation ? (
          <PopoverPopup
            anchor={editing.range}
            side="top"
            align="start"
            padding="compact"
            width="lg"
          >
            <ReplyAnnotationCommentBox
              key={editing.id}
              citation={editingAnnotation.citation}
              onDraftChange={(comment) => {
                draftRef.current = { id: editing.id, comment };
              }}
              onSave={(comment) => {
                setReplyAnnotationComment(editing.id, comment);
                draftRef.current = null;
                editReplyAnnotation(null);
              }}
              onCancel={() => closeEditing(false)}
              onRemove={() => {
                draftRef.current = null;
                removeReplyAnnotation(editing.id);
              }}
            />
          </PopoverPopup>
        ) : null}
      </Popover>
    </>
  );
}
