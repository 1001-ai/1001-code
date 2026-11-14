import type { LegendListRef } from "@legendapp/list/react";
import { resolveWorkGroupScrollAnchor } from "@t3tools/client-runtime/work-log/scroll-anchor";
import { useRouter, type ParsedLocation } from "@tanstack/react-router";
import { Undo2Icon } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore, type RefObject } from "react";

import { useStableCallback } from "../../hooks/useStableCallback";
import { assistantCitationFromLocation } from "../../lib/assistantCitationNavigation";
import { Button } from "../ui/button";
import {
  citationJumpKey,
  isNearAnchor,
  jumpBackTarget,
  jumpBackVisible,
  nextJumpBack,
  type JumpBackAnchor,
  type JumpBackEvent,
  type JumpBackRow,
  type JumpBackState,
} from "./jumpBack.logic";
import { resolveTimelineIsAtEnd } from "./MessagesTimeline.logic";
import type { TimelineViewport } from "./timelineViewport";
import { startTimelinePositionRestore } from "./useTimelinePositionRestore";

// The top row plus two below it, in case a fold change replaces the top one.
const ANCHOR_ROWS = 3;

/** One stay on a thread; leaving it drops the slot, so coming back shows no stale Back. */
interface JumpBackVisit {
  readonly threadKey: string;
}

function createJumpBackStore() {
  let state: JumpBackState<JumpBackVisit> | null = null;
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispatch: (event: JumpBackEvent<JumpBackVisit>) => {
      const next = nextJumpBack(state, event);
      if (next === state) return;
      state = next;
      for (const listener of listeners) listener();
    },
  };
}

function rowOffsetWithinRow(list: LegendListRef, element: HTMLElement, rowId: string) {
  const state = list.getState();
  const index = state.indexByKey(rowId);
  const row: HTMLElement | undefined =
    index === undefined ? undefined : state.elementAtIndex(index);
  return row ? element.getBoundingClientRect().top - row.getBoundingClientRect().top : undefined;
}

/** Measured against the scroll node, like the timeline's remembered position. */
function readAnchor(list: LegendListRef): JumpBackAnchor | null {
  const state = list.getState();
  const element = list.getScrollableNode();
  if (!element || state.data.length === 0) return null;
  if (resolveTimelineIsAtEnd(state) === true) return { atEnd: true, rows: [] };
  const top = resolveWorkGroupScrollAnchor(state);
  const topIndex = top === undefined ? undefined : state.indexByKey(top.rowId);
  if (top === undefined || topIndex === undefined) return null;
  const rows: JumpBackRow[] = [];
  for (let index = topIndex; index < topIndex + ANCHOR_ROWS && index < state.data.length; index++) {
    const rowId = (state.data[index] as { readonly id: string }).id;
    const offsetWithinRow =
      rowOffsetWithinRow(list, element, rowId) ??
      (index === topIndex ? top.offsetWithinRow : undefined);
    if (offsetWithinRow !== undefined) rows.push({ rowId, offsetWithinRow });
  }
  return { atEnd: false, rows };
}

/**
 * Remembers where the reader was when a link jumps this thread's timeline to a cited message,
 * and renders the Back pill that returns there. Links navigate through the router, so the place
 * is read in `onBeforeNavigate`, before the new location renders and the jump scrolls.
 */
export function useJumpBack({
  legendListRef,
  threadKey,
  thread,
  attachTimelineViewport,
  scrollToEnd,
}: {
  readonly legendListRef: RefObject<LegendListRef | null>;
  readonly threadKey: string;
  readonly thread: { readonly environmentId: string; readonly threadId: string };
  readonly attachTimelineViewport: (viewport: TimelineViewport) => () => void;
  readonly scrollToEnd: (animated?: boolean) => void;
}) {
  const [store] = useState(createJumpBackStore);
  const [visit, setVisit] = useState<JumpBackVisit>(() => ({ threadKey }));
  let currentVisit = visit;
  if (visit.threadKey !== threadKey) {
    currentVisit = { threadKey };
    setVisit(currentVisit);
  }
  const state = useSyncExternalStore(store.subscribe, store.get, store.get);
  const viewportRef = useRef<TimelineViewport | null>(null);
  const lastJumpKeyRef = useRef<string | null>(null);

  const recordJump = useStableCallback((location: ParsedLocation) => {
    const key = citationJumpKey(
      assistantCitationFromLocation(location.href),
      location.state.assistantCitationActivation ?? location.state.__TSR_key ?? location.href,
      thread,
      lastJumpKeyRef.current,
    );
    if (key === null) return;
    lastJumpKeyRef.current = key;
    const list = legendListRef.current;
    const anchor = list ? readAnchor(list) : null;
    store.dispatch(anchor ? { type: "jump", visit: currentVisit, anchor } : { type: "clear" });
  });
  const router = useRouter();
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the timeline's place when a link is about to jump it, before the new location renders
  useEffect(
    () => router.subscribe("onBeforeNavigate", ({ toLocation }) => recordJump(toLocation)),
    [router, recordJump],
  );

  const sample = useStableCallback(() => {
    const current = store.get();
    const list = legendListRef.current;
    const element = list?.getScrollableNode();
    if (current === null || !list || !element) return;
    if (current.visit !== currentVisit) {
      store.dispatch({ type: "clear" });
      return;
    }
    store.dispatch({
      type: "sample",
      near: isNearAnchor(current.anchor, {
        atEnd: resolveTimelineIsAtEnd(list.getState()) === true,
        viewportHeight: element.clientHeight,
        offsetWithinRow: (rowId) => rowOffsetWithinRow(list, element, rowId),
      }),
    });
  });

  const attachViewport = useStableCallback((viewport: TimelineViewport) => {
    const detachFollow = attachTimelineViewport(viewport);
    viewportRef.current = viewport;
    const unsubscribe = viewport.subscribe((navigation) =>
      store.dispatch({ type: "navigation", navigation }),
    );
    let frame: number | null = null;
    const onScroll = () => {
      if (frame !== null || store.get() === null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        sample();
      });
    };
    viewport.scrollNode.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      detachFollow();
      unsubscribe();
      viewport.scrollNode.removeEventListener("scroll", onScroll);
      if (frame !== null) cancelAnimationFrame(frame);
      if (viewportRef.current === viewport) viewportRef.current = null;
    };
  });

  const goBack = () => {
    const current = store.get();
    const list = legendListRef.current;
    const viewport = viewportRef.current;
    store.dispatch({ type: "clear" });
    if (current === null || !list || !viewport) return;
    const target = jumpBackTarget(
      current.anchor,
      (rowId) => list.getState().indexByKey(rowId) !== undefined,
    );
    if (target === null) return;
    if (target.kind === "end") {
      scrollToEnd(true);
      return;
    }
    startTimelinePositionRestore({
      list,
      viewport,
      listIdentityKey: threadKey,
      listOpenedOn: null,
      rememberedPosition: {
        rowId: target.rowId,
        offsetWithinRow: target.offsetWithinRow,
        scrollOffset: list.getState().scroll,
        atEnd: false,
      },
      citationPending: false,
      releaseForFind: false,
      onPositioned: () => {},
    });
  };

  return {
    attachViewport,
    backButton: jumpBackVisible(state, currentVisit) ? <JumpBackButton onBack={goBack} /> : null,
  };
}

function JumpBackButton({ onBack }: { readonly onBack: () => void }) {
  return (
    <div className="pointer-events-auto me-2">
      <Button
        data-jump-back="true"
        aria-label="Back to where you were"
        onPointerDown={(event) => event.preventDefault()}
        onClick={onBack}
        size="xs"
        variant="glass"
      >
        <Undo2Icon className="size-3.5" />
        Back
      </Button>
    </div>
  );
}
