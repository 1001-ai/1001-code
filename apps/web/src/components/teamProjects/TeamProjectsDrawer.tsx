import type { ScopedThreadRef } from "@t3tools/contracts";
import { lazy, Suspense } from "react";

import { useTeamProjectsDrawerStore, useThreadTerminalOpen } from "./teamProjectsDrawerState";

const TeamProjectsDrawerPanel = lazy(() => import("./TeamProjectsPanel"));

/**
 * The team projects graph at the bottom of the chat column, where the terminal drawer opens. One
 * drawer serves every thread; a thread's open terminal drawer takes the place while it is open.
 */
export function TeamProjectsDrawer(props: {
  readonly threadRef: ScopedThreadRef | null;
  readonly composerHeight: number;
}) {
  const open = useTeamProjectsDrawerStore((state) => state.open);
  const terminalOpen = useThreadTerminalOpen(props.threadRef);
  if (props.threadRef === null || !open || terminalOpen) return null;
  return (
    <Suspense fallback={null}>
      <TeamProjectsDrawerPanel
        threadEnvironmentId={props.threadRef.environmentId}
        composerHeight={props.composerHeight}
      />
    </Suspense>
  );
}
