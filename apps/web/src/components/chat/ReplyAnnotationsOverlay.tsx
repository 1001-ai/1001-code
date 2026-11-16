import type { ScopedThreadRef } from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";
import { resolveAssistantCitationRange } from "~/lib/assistantTextSelection";
import { Popover, PopoverPopup } from "../ui/popover";
import { ReplyAnnotationCommentBox } from "./ReplyAnnotationCommentBox";
import {
  editReplyAnnotation,
  removeReplyAnnotation,
  setReplyAnnotationComment,
  useEditingReplyAnnotationId,
  useThreadReplyAnnotations,
  type NumberedReplyAnnotation,
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

interface Placement {
  readonly annotation: NumberedReplyAnnotation;
  readonly range: Range;
  /** Null while the quote is scrolled out of the timeline. */
  readonly marker: { readonly top: number; readonly left: number } | null;
}

function samePlacements(left: ReadonlyArray<Placement>, right: ReadonlyArray<Placement>) {
  return (
    left.length === right.length &&
    left.every((placement, index) => {
      const other = right[index]!;
      return (
        placement.annotation === other.annotation &&
        placement.range === other.range &&
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

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- measures quote ranges in the virtualized timeline DOM, which React does not own, as it scrolls and re-renders
  useEffect(() => {
    if (!viewport || annotations.length === 0) return;
    const owner = Symbol("reply-annotations");
    let resolved: Array<{
      annotation: NumberedReplyAnnotation;
      range: Range;
      source: HTMLElement;
    }> = [];
    let stale = true;
    let frame = 0;
    const resolve = () => {
      const sources = [
        ...viewport.querySelectorAll<HTMLElement>("[data-assistant-citation-source]"),
      ];
      resolved = annotations.flatMap((annotation) => {
        const { citation } = annotation;
        const source = sources.find(
          (element) =>
            element.dataset.assistantCitationSource === citation.messageId &&
            element.dataset.assistantCitationEnvironment === citation.environmentId &&
            element.dataset.assistantCitationThread === citation.threadId,
        );
        const range = source ? resolveAssistantCitationRange(source, citation) : null;
        return source && range ? [{ annotation, range, source }] : [];
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
      const next = resolved.map(({ annotation, range, source }): Placement => {
        const line = range.getClientRects()[0];
        const visible = line && line.bottom > bounds.top && line.top < bounds.bottom;
        return {
          annotation,
          range,
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
      const hit = resolved.find(({ range }) =>
        Array.from(range.getClientRects()).some(
          (rect) =>
            event.clientX >= rect.left &&
            event.clientX <= rect.right &&
            event.clientY >= rect.top &&
            event.clientY <= rect.bottom,
        ),
      );
      if (hit) editReplyAnnotation(hit.annotation.id);
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
  }, [annotations, viewport]);

  if (annotations.length === 0) return null;
  const editing = placements.find((placement) => placement.annotation.id === editingId) ?? null;
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
        {placements.map(({ annotation, marker }) =>
          marker ? (
            <button
              key={annotation.id}
              type="button"
              aria-label={`Annotation ${annotation.number}${annotation.citation.comment ? `: ${annotation.citation.comment}` : ""}`}
              aria-expanded={annotation.id === editingId}
              className="pointer-events-auto absolute flex size-6 items-center justify-center rounded-full rounded-br-sm bg-info font-semibold text-white text-xs shadow-sm focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-white"
              style={{ top: marker.top, left: marker.left }}
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => {
                const wasOpen = annotation.id === editingId;
                closeEditing(true);
                if (!wasOpen) editReplyAnnotation(annotation.id);
              }}
            >
              {annotation.number}
            </button>
          ) : null,
        )}
      </div>
      <style>{HIGHLIGHT_STYLE}</style>
      <Popover
        open={editing !== null}
        onOpenChange={(open, details) => {
          if (open) return;
          // A marker click is handled by the marker, which saves before it switches.
          const target = details.event.target;
          if (target instanceof Node && markersRef.current?.contains(target)) return;
          closeEditing(details.reason !== "escape-key");
        }}
      >
        {editing ? (
          <PopoverPopup
            anchor={editing.range}
            side="top"
            align="start"
            padding="compact"
            width="lg"
          >
            <ReplyAnnotationCommentBox
              key={editing.annotation.id}
              citation={editing.annotation.citation}
              onDraftChange={(comment) => {
                draftRef.current = { id: editing.annotation.id, comment };
              }}
              onSave={(comment) => {
                setReplyAnnotationComment(editing.annotation.id, comment);
                draftRef.current = null;
                editReplyAnnotation(null);
              }}
              onCancel={() => closeEditing(false)}
              onRemove={() => {
                draftRef.current = null;
                removeReplyAnnotation(editing.annotation.id);
              }}
            />
          </PopoverPopup>
        ) : null}
      </Popover>
    </>
  );
}
