import { XIcon } from "lucide-react";
import {
  cloneElement,
  type ComponentProps,
  isValidElement,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

import { useBrowserDefaults } from "~/browser/browserDefaults";
import { isElectron } from "../../env";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { cn } from "../../lib/utils";
import { workspaceAreaProps } from "../../lib/workspaceFocus";
import type { RightPanelSurface } from "../../rightPanelStore";
import { ChatRightPanel } from "../chat/ChatRightPanel";
import { RightPanelEmptyState, surfaceTitle } from "../RightPanelTabs";
import { Button } from "../ui/button";
import { shouldRevealActivePane } from "./paneStrip.logic";
import { PANE_STRIP_COLUMN_CLASS, type PaneStripHandle, usePaneOnScreen } from "./paneStripMode";
import { usePaneStripOrder } from "./paneStripPlacement";

type PanelProps = ComponentProps<typeof ChatRightPanel>;

interface PaneStripProps {
  readonly paneStrip: PaneStripHandle | null;
  readonly threadKey: string;
}

const PANE_HEADER_CLASS =
  "flex h-[var(--workspace-topbar-height)] min-h-[var(--workspace-topbar-height)] shrink-0 items-center gap-1 pr-2 pl-3 text-sm font-medium";

/** The thread's right panel: its tabs, or in strip mode one column for each pane. */
export function PaneStripOrPanel(props: PanelProps & PaneStripProps) {
  const { paneStrip, threadKey, ...panel } = props;
  if (paneStrip === null) return <ChatRightPanel {...panel} />;
  if (paneStrip.panesHost === null || panel.open !== true) return null;
  return createPortal(
    <PaneStripPanes {...panel} host={paneStrip.panesHost} threadKey={threadKey} />,
    paneStrip.panesHost,
  );
}

function PaneStripPanes(
  props: PanelProps & Omit<PaneStripProps, "paneStrip"> & { readonly host: HTMLElement },
) {
  const { host, threadKey, activeSurfaceId } = props;
  const browserProfiles = useBrowserDefaults().profiles;
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const surfaces = usePaneStripOrder(props.surfaces);
  const shown = useRef<{ threadKey: string; activeSurfaceId: string | null } | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- scrolls the strip's DOM scroller to the pane that just became active
  useEffect(() => {
    const next = { threadKey, activeSurfaceId };
    const reveal = shouldRevealActivePane(shown.current, next);
    shown.current = next;
    if (!reveal) return;
    for (const pane of host.children) {
      if (pane instanceof HTMLElement && pane.dataset.paneStripPane === activeSurfaceId) {
        pane.scrollIntoView({
          inline: "nearest",
          block: "nearest",
          behavior: reducedMotion ? "auto" : "smooth",
        });
      }
    }
  }, [activeSurfaceId, host, reducedMotion, threadKey]);

  return (
    <>
      {surfaces.map((surface) => (
        <StripPane
          key={surface.id}
          surface={surface}
          title={surfaceTitle(surface, props.previewSessions, props.terminalLabelsById)}
          active={surface.id === activeSurfaceId}
          onActivate={props.onActivate}
          onClose={props.onCloseSurface}
          content={props.children}
        />
      ))}
      <section
        aria-label="New pane"
        data-pane-strip-label="New pane"
        className={cn(PANE_STRIP_COLUMN_CLASS, "border-l border-border bg-background")}
      >
        <header className={cn(PANE_HEADER_CLASS, isElectron && "drag-region")}>New pane</header>
        <div className="flex min-h-0 flex-1 flex-col">
          <RightPanelEmptyState
            onAddBrowser={props.onAddBrowser}
            onAddBrowserInProfile={props.onAddBrowserInProfile}
            browserProfiles={browserProfiles}
            onAddTerminal={props.onAddTerminal}
            onAddDiff={props.onAddDiff}
            onAddFiles={props.onAddFiles}
            onAddPullRequest={props.onAddPullRequest}
            onAddPullRequests={props.onAddPullRequests}
            onAddDevice={props.onAddDevice}
            onAddSideChat={props.onAddSideChat}
            onAddTeamSurface={props.onAddTeamSurface}
            browserAvailable={props.browserAvailable}
            terminalAvailable={props.terminalAvailable}
            diffAvailable={props.diffAvailable}
            filesAvailable={props.filesAvailable}
            pullRequestAvailable={props.pullRequestAvailable}
            pullRequestsAvailable={props.pullRequestsAvailable}
            deviceAvailable={props.deviceAvailable}
            sideChatAvailable={props.sideChatAvailable === true}
            sideChatDisabledReason={props.sideChatDisabledReason ?? null}
          />
        </div>
      </section>
    </>
  );
}

function StripPane(props: {
  readonly surface: RightPanelSurface;
  readonly title: string;
  readonly active: boolean;
  readonly onActivate: (surface: RightPanelSurface) => void;
  readonly onClose: (surface: RightPanelSurface) => void;
  /** The tab panel's content element for its one active surface; each pane draws a copy for its own. */
  readonly content: ReactNode;
}) {
  const { surface, title, active } = props;
  const [observe, onScreen] = usePaneOnScreen();
  // A pane's content mounts the first time it shows, and pauses whenever it is off screen.
  const [seen, setSeen] = useState(false);
  if (onScreen && !seen) setSeen(true);
  const activate = () => {
    if (!active) props.onActivate(surface);
  };

  return (
    <section
      ref={observe}
      {...workspaceAreaProps("panel", 4, `Workspace panel: ${title}`)}
      data-pane-strip-pane={surface.id}
      data-pane-strip-label={title}
      onPointerDownCapture={activate}
      onFocusCapture={activate}
      className={cn(PANE_STRIP_COLUMN_CLASS, "border-l border-border bg-background")}
    >
      {/* A side chat brings its own title row, with its own Close. */}
      {surface.kind === "side-chat" ? null : (
        <header className={cn(PANE_HEADER_CLASS, isElectron && "drag-region")}>
          <span className="min-w-0 max-w-60 truncate">{title}</span>
          <span className="flex [-webkit-app-region:no-drag]">
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={`Close ${title}`}
              onClick={() => props.onClose(surface)}
            >
              <XIcon />
            </Button>
          </span>
        </header>
      )}
      <div className="flex min-h-0 flex-1 flex-col">
        {seen && isValidElement<{ surface: RightPanelSurface; visible: boolean }>(props.content)
          ? cloneElement(props.content, { surface, visible: onScreen })
          : null}
      </div>
    </section>
  );
}
