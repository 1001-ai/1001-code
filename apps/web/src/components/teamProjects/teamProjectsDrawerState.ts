import type { ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { useComposerDraftStore } from "../../composerDraftStore";
import { useThreadRouteTarget } from "../../hooks/useThreadRouteTarget";
import { resolveStorage } from "../../lib/storage";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../../terminalUiStateStore";
import { useTeamCatalog } from "../../state/teamCatalog";
import { DEFAULT_THREAD_TERMINAL_HEIGHT } from "../../types";
import { useNavigateToMainApp } from "../sidebar/mainAppLocation";
import {
  resolveTeamProjectsDrawerOpen,
  teamProjectsDrawerToggle,
} from "./teamProjectsDrawerState.logic";

interface TeamProjectsDrawerState {
  /**
   * One drawer for every thread: the catalog is the environment's, not the thread's. Null until
   * the user opens or closes it, and then it is on wherever a catalog is set.
   */
  readonly open: boolean | null;
  readonly height: number;
  /** Set by a "show" off a thread; the thread it lands in closes its terminal. Not persisted. */
  readonly closeTerminalOnArrival: boolean;
  readonly setOpen: (open: boolean) => void;
  readonly setCloseTerminalOnArrival: (close: boolean) => void;
  readonly setHeight: (height: number) => void;
}

export const useTeamProjectsDrawerStore = create<TeamProjectsDrawerState>()(
  persist(
    (set) => ({
      open: null,
      height: DEFAULT_THREAD_TERMINAL_HEIGHT,
      closeTerminalOnArrival: false,
      setOpen: (open) => set({ open }),
      setCloseTerminalOnArrival: (closeTerminalOnArrival) => set({ closeTerminalOnArrival }),
      setHeight: (height) => set({ height }),
    }),
    {
      name: "t3code:team-projects-drawer:v2",
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({ open: state.open, height: state.height }),
    },
  ),
);

/**
 * Whether the graph is on. Until the user chooses, it is on where the environment has a catalog,
 * so the catalog is subscribed only then; an explicit choice needs no catalog read.
 */
export function useTeamProjectsDrawerOpen(threadRef: ScopedThreadRef | null): boolean {
  const stored = useTeamProjectsDrawerStore((state) => state.open);
  const snapshot = useTeamCatalog(stored === null ? (threadRef?.environmentId ?? null) : null);
  return resolveTeamProjectsDrawerOpen(stored, snapshot?.source != null);
}

/** The thread's terminal drawer has the bottom area while it is open. */
export function useThreadTerminalOpen(threadRef: ScopedThreadRef | null): boolean {
  return useTerminalUiStateStore((state) =>
    threadRef === null
      ? false
      : selectThreadTerminalUiState(state.terminalUiStateByThreadKey, threadRef).terminalOpen,
  );
}

function useRouteThreadRef(): ScopedThreadRef | null {
  const target = useThreadRouteTarget();
  const draftSession = useComposerDraftStore((store) =>
    target?.kind === "draft" ? store.getDraftSession(target.draftId) : null,
  );
  if (target?.kind === "server") return target.threadRef;
  if (draftSession) {
    return { environmentId: draftSession.environmentId, threadId: draftSession.threadId };
  }
  return null;
}

/** Shows or hides the graph in the current thread's bottom area, the last thread's off a thread. */
export function useTeamProjectsDrawerToggle() {
  const threadRef = useRouteThreadRef();
  const open = useTeamProjectsDrawerOpen(threadRef);
  const setOpen = useTeamProjectsDrawerStore((state) => state.setOpen);
  const setCloseTerminalOnArrival = useTeamProjectsDrawerStore(
    (state) => state.setCloseTerminalOnArrival,
  );
  const terminalOpen = useThreadTerminalOpen(threadRef);
  const setTerminalOpen = useTerminalUiStateStore((state) => state.setTerminalOpen);
  const navigateToMainApp = useNavigateToMainApp();
  const visible = threadRef !== null && open && !terminalOpen;

  const toggle = () => {
    const step = teamProjectsDrawerToggle({ onThread: threadRef !== null, open, terminalOpen });
    setOpen(step.open);
    if (step.leaveForThread) {
      setCloseTerminalOnArrival(step.closeTerminal);
      void navigateToMainApp();
    } else if (step.closeTerminal && threadRef !== null) {
      setTerminalOpen(threadRef, false);
    }
  };

  return { visible, toggle };
}
