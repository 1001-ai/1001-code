import type { ScopedThreadRef } from "@t3tools/contracts";
import { ScrollTextIcon } from "lucide-react";

import { useRightPanelStore } from "~/rightPanelStore";
import { agentsBoardSurfaceActions } from "../agentsBoard/agentsBoardSurface";
import { boardSurfaceActions } from "../board/boardSurface";
import { type CommandPaletteActionItem, ITEM_ICON_CLASS } from "../CommandPalette.logic";

export type TeamSurfaceKind = "board" | "memory" | "agents-board";

/** The team surfaces in the right panel's new-surface menus; absent where no project is open. */
export function teamSurfaceActions(onAdd: ((kind: TeamSurfaceKind) => void) | undefined) {
  return onAdd
    ? [
        ...boardSurfaceActions(() => onAdd("board")),
        {
          label: "Memory",
          description: "What agents are told about how the team works.",
          icon: ScrollTextIcon,
          shortcut: "E",
          available: true,
          disabledReason: "Available when a project is open.",
          onClick: () => onAdd("memory"),
        },
        ...agentsBoardSurfaceActions(() => onAdd("agents-board")),
      ]
    : [];
}

export function MemorySurfaceIcon() {
  return <ScrollTextIcon className="size-3 shrink-0" />;
}

/** The command palette's way to the memory of the open thread's project. */
export function memoryPaletteAction(threadRef: ScopedThreadRef): CommandPaletteActionItem {
  return {
    kind: "action",
    value: "action:open-memory",
    searchTerms: ["memory", "instructions", "rules", "agents"],
    title: "Open memory",
    icon: <ScrollTextIcon className={ITEM_ICON_CLASS} />,
    run: async () => {
      useRightPanelStore.getState().open(threadRef, "memory");
    },
  };
}
