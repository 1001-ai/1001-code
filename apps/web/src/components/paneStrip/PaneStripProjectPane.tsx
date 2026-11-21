import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ProjectId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { HistoryIcon, InboxIcon } from "lucide-react";
import { memo, type ReactNode, useEffect, useState } from "react";

import { ComposerHandleContext } from "../../composerHandleContext";
import { isElectron } from "../../env";
import { observeResize } from "../../lib/observeResize";
import type { SideChatParentPanel } from "../../lib/sideChatPane";
import { cn } from "../../lib/utils";
import { hostRightPanel } from "../../rightPanelStore";
import { useInboxAgent } from "../../state/inboxAgent";
import { useProjectMoments } from "../../state/projectMoments";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "../../workspaceTitlebar";
import ChatView from "../ChatView";
import { BackgroundThreadContext } from "../chat/backgroundThread";
import { TimelineMomentCards } from "../chat/TimelineMomentCards";
import { paneStripInboxThreadId } from "./paneStrip.logic";
import { usePaneOnScreen } from "./paneStripMode";
import { PANE_STRIP_PROJECT_ATTRIBUTE, PaneStripNudge } from "./PaneStripNudge";

// The Inbox agent edits no files and has no terminal, so there is nothing to hand the thread.
const inboxParentPanel = (hostRef: ScopedThreadRef): SideChatParentPanel => ({
  hostRef,
  openToolDiff: () => {},
  runShellCommand: () => {},
});

// The cards were written for a chat's margin: these stand in for the open chat's rows and minimap.
const NO_ROWS: [] = [];
const NO_STRIPS = new Map<string, HTMLSpanElement>();
const ignore = () => {};

/**
 * The strip's leftmost column: the project's Inbox chat beside its activity feed (the timeline
 * cards), one snap stop. Neither half mounts until the column is first on screen.
 */
export function PaneStripProjectPane(props: {
  readonly threadRef: ScopedThreadRef;
  readonly projectId: ProjectId;
  readonly nudgeHost: HTMLElement | null;
}) {
  const { threadRef, projectId } = props;
  const inbox = useInboxAgent({ environmentId: threadRef.environmentId, projectId });
  const inboxThreadId = paneStripInboxThreadId({
    routeThreadId: threadRef.threadId,
    inboxThreadId: inbox.threadId,
  });
  const [observe, onScreen] = usePaneOnScreen();
  const [seen, setSeen] = useState(false);
  if (onScreen && !seen) setSeen(true);

  return (
    <section
      ref={observe}
      {...{ [PANE_STRIP_PROJECT_ATTRIBUTE]: "" }}
      data-pane-strip-label={inboxThreadId === null ? "Activity" : "Inbox"}
      aria-label="Project"
      className={cn(
        "flex min-h-0 min-w-0 shrink-0 grow-0 snap-start flex-row border-r border-border bg-background",
        inboxThreadId === null ? "basis-[min(100%,22rem)]" : "basis-[min(100%,52rem)]",
      )}
    >
      {inboxThreadId === null ? null : (
        <div
          data-side-chat-pane
          className="flex min-h-0 min-w-0 flex-[1_1_30rem] flex-col border-r border-border"
        >
          <PaneHeader first icon={<InboxIcon aria-hidden className={ICON_CLASS} />}>
            Inbox
          </PaneHeader>
          {/* Only while on screen: a mounted chat counts as reading the Inbox, which clears its unread mark. */}
          {onScreen ? (
            <InboxChat
              hostThreadId={threadRef.threadId}
              environmentId={threadRef.environmentId}
              threadId={inboxThreadId}
            />
          ) : null}
        </div>
      )}
      <div
        className={cn(
          "flex min-h-0 flex-col",
          inboxThreadId === null ? "min-w-0 flex-1" : "min-w-56 flex-[0_1_22rem]",
        )}
      >
        <PaneHeader
          first={inboxThreadId === null}
          icon={<HistoryIcon aria-hidden className={ICON_CLASS} />}
        >
          Activity
        </PaneHeader>
        {seen ? <ActivityCards threadRef={threadRef} projectId={projectId} /> : null}
      </div>
      <PaneStripNudge
        key={threadRef.threadId}
        host={props.nudgeHost}
        environmentId={threadRef.environmentId}
        projectId={projectId}
        openThreadId={threadRef.threadId}
        inboxThreadId={inboxThreadId}
        paneOnScreen={onScreen}
      />
    </section>
  );
}

const ICON_CLASS = "size-4 shrink-0 text-muted-foreground";

function PaneHeader(props: {
  /** The leftmost header makes room for the window controls when the sidebar is collapsed. */
  readonly first: boolean;
  readonly icon: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <header
      className={cn(
        "flex h-[var(--workspace-topbar-height)] min-h-[var(--workspace-topbar-height)] shrink-0 items-center gap-2 px-3 text-sm font-medium",
        isElectron && "drag-region",
        props.first && COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
      )}
    >
      {props.icon}
      {props.children}
    </header>
  );
}

// Memoized so the column's on-screen changes and the open thread's re-renders skip the chat.
const InboxChat = memo(function InboxChat(props: {
  readonly hostThreadId: ThreadId;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const { hostThreadId, environmentId, threadId } = props;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers the open thread as host in the panel store, so links in the Inbox open as that thread's panes
  useEffect(
    () =>
      hostRightPanel(
        scopeThreadRef(environmentId, threadId),
        scopeThreadRef(environmentId, hostThreadId),
      ),
    [hostThreadId, environmentId, threadId],
  );
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <BackgroundThreadContext value>
        <ComposerHandleContext value={null}>
          <ChatView
            environmentId={environmentId}
            threadId={threadId}
            routeKind="server"
            embedded={inboxParentPanel(scopeThreadRef(environmentId, hostThreadId))}
          />
        </ComposerHandleContext>
      </BackgroundThreadContext>
    </div>
  );
});

function ActivityCards(props: {
  readonly threadRef: ScopedThreadRef;
  readonly projectId: ProjectId;
}) {
  const moments = useProjectMoments(props.threadRef.environmentId, props.projectId);
  const [width, setWidth] = useState(0);
  const [measure] = useState(() => (node: HTMLDivElement | null) => {
    if (node === null) return undefined;
    setWidth(node.clientWidth);
    return observeResize(node, () => setWidth(node.clientWidth));
  });
  return (
    <div ref={measure} className="relative min-h-0 flex-1">
      {moments !== null && width > 0 ? (
        <TimelineMomentCards
          threadRef={props.threadRef}
          projectId={props.projectId}
          moments={moments.moments}
          gutterWidth={width}
          rows={NO_ROWS}
          stripMap={NO_STRIPS}
          onWheel={ignore}
          onJump={ignore}
        />
      ) : null}
    </div>
  );
}
