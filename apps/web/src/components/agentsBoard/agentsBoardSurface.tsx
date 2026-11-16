import type { ScopedThreadRef } from "@t3tools/contracts";
import { BotMessageSquareIcon } from "lucide-react";

import { useRightPanelStore } from "~/rightPanelStore";
import { type CommandPaletteActionItem, ITEM_ICON_CLASS } from "../CommandPalette.logic";

/** The agents board's entry in the right panel's new-surface menus. */
export function agentsBoardSurfaceActions(onAdd: () => void) {
  return [
    {
      label: "Agents board",
      description: "Messages from the agents working in the team project.",
      icon: BotMessageSquareIcon,
      shortcut: "A",
      available: true,
      disabledReason: "Available when a project is open.",
      onClick: onAdd,
    },
  ];
}

export function AgentsBoardSurfaceIcon() {
  return <BotMessageSquareIcon className="size-3 shrink-0" />;
}

/** The command palette's way to the agents board of the open thread's project. */
export function agentsBoardPaletteAction(threadRef: ScopedThreadRef): CommandPaletteActionItem {
  return {
    kind: "action",
    value: "action:open-agents-board",
    searchTerms: ["agents board", "agents", "messages", "reports", "team"],
    title: "Open agents board",
    icon: <BotMessageSquareIcon className={ITEM_ICON_CLASS} />,
    run: async () => {
      useRightPanelStore.getState().open(threadRef, "agents-board");
    },
  };
}
