import type { ScopedThreadRef } from "@t3tools/contracts";
import { SquareKanbanIcon } from "lucide-react";

import { useRightPanelStore } from "~/rightPanelStore";
import { type CommandPaletteActionItem, ITEM_ICON_CLASS } from "../CommandPalette.logic";

/** The board's entry in the right panel's new-surface menus; absent where no project is open. */
export function boardSurfaceActions(onAddBoard: (() => void) | undefined) {
  return onAddBoard
    ? [
        {
          label: "Board",
          description: "The team project's Linear issues.",
          icon: SquareKanbanIcon,
          shortcut: "K",
          available: true,
          disabledReason: "Available when a project is open.",
          onClick: onAddBoard,
        },
      ]
    : [];
}

export function BoardSurfaceIcon() {
  return <SquareKanbanIcon className="size-3 shrink-0" />;
}

/** The command palette's way to the board of the open thread's project. */
export function boardPaletteAction(threadRef: ScopedThreadRef): CommandPaletteActionItem {
  return {
    kind: "action",
    value: "action:open-board",
    searchTerms: ["board", "linear", "issues", "tasks", "kanban"],
    title: "Open board",
    icon: <SquareKanbanIcon className={ITEM_ICON_CLASS} />,
    run: async () => {
      useRightPanelStore.getState().open(threadRef, "board");
    },
  };
}
