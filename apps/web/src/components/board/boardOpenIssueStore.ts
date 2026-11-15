import { create } from "zustand";

/** The issue a thread's Board shows in detail, so a click outside the panel can open one. */
export interface BoardOpenIssue {
  /** The issue's id, or its identifier when the click came from outside the board. */
  readonly issue: string;
  /** Opened from outside the board: one the board does not show gets a note, not a quiet reset. */
  readonly fromOutside: boolean;
  readonly linearUrl: string | null;
}

interface BoardOpenIssueState {
  readonly byThreadKey: Readonly<Record<string, BoardOpenIssue>>;
  readonly setOpenIssue: (threadKey: string, issue: BoardOpenIssue | null) => void;
}

export const useBoardOpenIssueStore = create<BoardOpenIssueState>()((set) => ({
  byThreadKey: {},
  setOpenIssue: (threadKey, issue) =>
    set((state) => {
      const { [threadKey]: _previous, ...rest } = state.byThreadKey;
      return { byThreadKey: issue === null ? rest : { ...rest, [threadKey]: issue } };
    }),
}));
