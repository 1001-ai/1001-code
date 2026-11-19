import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { InboxIcon } from "lucide-react";
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";

import { ComposerHandleContext } from "../../composerHandleContext";
import { isElectron } from "../../env";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import type { SideChatParentPanel } from "../../lib/sideChatPane";
import { cn } from "../../lib/utils";
import { RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY } from "../../rightPanelLayout";
import {
  hostRightPanel,
  selectThreadRightPanelState,
  useRightPanelStore,
} from "../../rightPanelStore";
import { useQuietThreadShell } from "../../state/entities";
import { useInboxAgent } from "../../state/inboxAgent";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "../../workspaceTitlebar";
import ChatView from "../ChatView";
import { BackgroundThreadContext } from "../chat/backgroundThread";
import { PANE_STRIP_ATTRIBUTE, paneStripInboxThreadId } from "./paneStrip.logic";
import {
  PANE_STRIP_COLUMN_CLASS,
  PaneStripContext,
  usePaneOnScreen,
  usePaneStripSetting,
} from "./paneStripMode";

// The Inbox agent edits no files and has no terminal, so there is nothing to hand the thread.
const INBOX_PARENT_PANEL: SideChatParentPanel = {
  openToolDiff: () => {},
  runShellCommand: () => {},
};

/**
 * With the Labs switch on, lays the open thread out as one column of a sideways-scrolling strip:
 * the project's Inbox to its left, the thread's panes to its right.
 */
export function PaneStripLayout(props: {
  readonly threadRef: ScopedThreadRef | null;
  readonly children: ReactNode;
}) {
  const [enabled] = usePaneStripSetting();
  return enabled ? <PaneStrip {...props} /> : props.children;
}

function PaneStrip(props: {
  readonly threadRef: ScopedThreadRef | null;
  readonly children: ReactNode;
}) {
  const { threadRef } = props;
  // Narrow windows keep the sheet, so the strip is a lone thread there.
  const narrow = useMediaQuery(RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY);
  const [panesHost, setPanesHost] = useState<HTMLDivElement | null>(null);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const threadColumnRef = useRef<HTMLDivElement | null>(null);
  const shell = useQuietThreadShell(threadRef);
  const inbox = useInboxAgent(
    threadRef === null || shell === null
      ? null
      : { environmentId: threadRef.environmentId, projectId: shell.projectId },
  );
  const inboxThreadId = narrow
    ? null
    : paneStripInboxThreadId({
        routeThreadId: threadRef?.threadId ?? null,
        inboxThreadId: inbox.threadId,
      });
  const panesOpen = useRightPanelStore(
    (state) =>
      !narrow &&
      threadRef !== null &&
      selectThreadRightPanelState(state.byThreadKey, threadRef).isOpen,
  );
  const threadKey = threadRef === null ? null : scopedThreadKey(threadRef);
  const inboxShown = inboxThreadId !== null;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- rests the scroller on the thread column when a thread opens or the Inbox column appears beside it
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    const threadColumn = threadColumnRef.current;
    if (threadKey === null || scroller === null || threadColumn === null) return;
    scroller.scrollLeft = inboxShown ? threadColumn.offsetLeft : 0;
  }, [threadKey, inboxShown]);

  return (
    <div
      ref={scrollerRef}
      {...{ [PANE_STRIP_ATTRIBUTE]: "" }}
      className="relative flex min-h-0 min-w-0 flex-1 snap-x snap-mandatory overflow-x-auto overflow-y-hidden overscroll-x-contain [scrollbar-width:none]"
    >
      {threadRef !== null && inboxThreadId !== null ? (
        <InboxPane
          key={`${threadRef.environmentId}:${inboxThreadId}`}
          hostRef={threadRef}
          threadId={inboxThreadId}
        />
      ) : null}
      <div
        ref={threadColumnRef}
        className={cn(
          panesOpen
            ? PANE_STRIP_COLUMN_CLASS
            : "flex min-h-0 min-w-0 shrink-0 basis-full snap-start",
          "flex-row",
        )}
      >
        <PaneStripContext value={narrow ? null : { panesHost }}>{props.children}</PaneStripContext>
      </div>
      <div ref={setPanesHost} className="contents" />
    </div>
  );
}

function InboxPane(props: { readonly hostRef: ScopedThreadRef; readonly threadId: ThreadId }) {
  const { hostRef, threadId } = props;
  const [observe, onScreen] = usePaneOnScreen();
  // The Inbox's chat mounts the first time its column shows, so a strip resting on the thread
  // carries one chat, not two.
  const [seen, setSeen] = useState(false);
  if (onScreen && !seen) setSeen(true);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers the open thread as host in the panel store, so links in the Inbox open as that thread's panes
  useEffect(
    () => hostRightPanel(scopeThreadRef(hostRef.environmentId, threadId), hostRef),
    [hostRef, threadId],
  );

  return (
    <section
      ref={observe}
      data-side-chat-pane
      aria-label="Inbox"
      className={cn(PANE_STRIP_COLUMN_CLASS, "border-r border-border bg-background")}
    >
      <header
        className={cn(
          "flex h-[var(--workspace-topbar-height)] min-h-[var(--workspace-topbar-height)] shrink-0 items-center gap-2 px-3 text-sm font-medium",
          isElectron && "drag-region",
          COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
        )}
      >
        <InboxIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        Inbox
      </header>
      <div className="flex min-h-0 flex-1 flex-col">
        {seen ? (
          <BackgroundThreadContext value>
            <ComposerHandleContext value={null}>
              <ChatView
                environmentId={hostRef.environmentId}
                threadId={threadId}
                routeKind="server"
                embedded={INBOX_PARENT_PANEL}
              />
            </ComposerHandleContext>
          </BackgroundThreadContext>
        ) : null}
      </div>
    </section>
  );
}
