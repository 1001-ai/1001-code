import type { ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { useComposerDraftStore } from "../../composerDraftStore";
import { useThreadRouteTarget } from "../../hooks/useThreadRouteTarget";
import { resolveStorage } from "../../lib/storage";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../../terminalUiStateStore";
import { DEFAULT_THREAD_TERMINAL_HEIGHT } from "../../types";
import { useNavigateToMainApp } from "../sidebar/mainAppLocation";
import { teamProjectsDrawerToggle } from "./teamProjectsDrawerState.logic";

interface TeamProjectsDrawerState {
  /** One drawer for every thread: the catalog is the environment's, not the thread's. */
  readonly open: boolean;
  readonly height: number;
  readonly setOpen: (open: boolean) => void;
  readonly setHeight: (height: number) => void;
}

export const useTeamProjectsDrawerStore = create<TeamProjectsDrawerState>()(
  persist(
    (set) => ({
      open: false,
      height: DEFAULT_THREAD_TERMINAL_HEIGHT,
      setOpen: (open) => set({ open }),
      setHeight: (height) => set({ height }),
    }),
    {
      name: "t3code:team-projects-drawer:v1",
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({ open: state.open, height: state.height }),
    },
  ),
);

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
  const open = useTeamProjectsDrawerStore((state) => state.open);
  const setOpen = useTeamProjectsDrawerStore((state) => state.setOpen);
  const terminalOpen = useThreadTerminalOpen(threadRef);
  const setTerminalOpen = useTerminalUiStateStore((state) => state.setTerminalOpen);
  const navigateToMainApp = useNavigateToMainApp();
  const visible = threadRef !== null && open && !terminalOpen;

  const toggle = () => {
    const step = teamProjectsDrawerToggle({ onThread: threadRef !== null, open, terminalOpen });
    setOpen(step.open);
    if (step.closeTerminal && threadRef !== null) setTerminalOpen(threadRef, false);
    if (step.leaveForThread) void navigateToMainApp();
  };

  return { visible, toggle };
}
