import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { lazy, Suspense, useEffect } from "react";

import { cn } from "../../lib/utils";
import { usePanelAnimationSettings, usePanelPresence } from "../../panelAnimations";
import { useTerminalUiStateStore } from "../../terminalUiStateStore";
import {
  useTeamProjectsDrawerOpen,
  useTeamProjectsDrawerStore,
  useThreadTerminalOpen,
} from "./teamProjectsDrawerState";

const TeamProjectsDrawerPanel = lazy(() => import("./TeamProjectsPanel"));

/**
 * The team projects graph at the bottom of the chat column, where the terminal drawer opens. One
 * drawer serves every thread, on by default where a catalog is set; a thread's open terminal
 * drawer takes the place while it is open.
 */
export function TeamProjectsDrawer(props: {
  readonly threadRef: ScopedThreadRef | null;
  readonly composerHeight: number;
}) {
  const { threadRef } = props;
  const open = useTeamProjectsDrawerOpen(threadRef);
  const terminalOpen = useThreadTerminalOpen(threadRef);
  // The terminal drawer stays in layout while it collapses; mounting the graph then would stack both.
  const { active: animated, durationMs } = usePanelAnimationSettings();
  const threadKey = threadRef === null ? null : scopedThreadKey(threadRef);
  const terminal = usePanelPresence(terminalOpen, true, animated, threadKey, durationMs);
  const shown = threadRef !== null && open && !terminal.present;
  // Stays mounted while it collapses, like the terminal drawer.
  const drawer = usePanelPresence(shown, true, animated, threadKey, durationMs);
  const closeTerminalOnArrival = useTeamProjectsDrawerStore(
    (state) => state.closeTerminalOnArrival,
  );
  const setCloseTerminalOnArrival = useTeamProjectsDrawerStore(
    (state) => state.setCloseTerminalOnArrival,
  );
  const setTerminalOpen = useTerminalUiStateStore((state) => state.setTerminalOpen);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a "show" made off a thread closes the terminal of the thread it lands in, which only this view knows
  useEffect(() => {
    if (!closeTerminalOnArrival || threadRef === null) return;
    setCloseTerminalOnArrival(false);
    setTerminalOpen(threadRef, false);
  }, [closeTerminalOnArrival, setCloseTerminalOnArrival, setTerminalOpen, threadRef]);

  if (threadRef === null || !drawer.present) return null;
  return (
    <div
      className={cn(
        "grid shrink-0 overflow-clip",
        shown ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
        "[[data-panel-animations=true]_&]:transition-[grid-template-rows] [[data-panel-animations=true]_&]:duration-(--panel-animation-duration) [[data-panel-animations=true]_&]:ease-out",
        shown && "[[data-panel-animations=true]_&]:starting:grid-rows-[0fr]!",
      )}
    >
      <div className="min-h-0 overflow-clip">
        <Suspense fallback={null}>
          <TeamProjectsDrawerPanel
            threadEnvironmentId={threadRef.environmentId}
            composerHeight={props.composerHeight}
          />
        </Suspense>
      </div>
    </div>
  );
}
