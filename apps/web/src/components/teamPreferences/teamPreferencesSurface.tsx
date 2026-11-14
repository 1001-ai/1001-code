import type { ScopedThreadRef } from "@t3tools/contracts";
import { ScrollTextIcon } from "lucide-react";

import { useRightPanelStore } from "~/rightPanelStore";
import { boardSurfaceActions } from "../board/boardSurface";
import { type CommandPaletteActionItem, ITEM_ICON_CLASS } from "../CommandPalette.logic";

export type TeamSurfaceKind = "board" | "preferences";

/** The team surfaces in the right panel's new-surface menus; absent where no project is open. */
export function teamSurfaceActions(onAdd: ((kind: TeamSurfaceKind) => void) | undefined) {
  return onAdd
    ? [
        ...boardSurfaceActions(() => onAdd("board")),
        {
          label: "Team preferences",
          description: "What agents are told about how the team works.",
          icon: ScrollTextIcon,
          shortcut: "E",
          available: true,
          disabledReason: "Available when a project is open.",
          onClick: () => onAdd("preferences"),
        },
      ]
    : [];
}

export function TeamPreferencesSurfaceIcon() {
  return <ScrollTextIcon className="size-3 shrink-0" />;
}

/** The command palette's way to the team preferences of the open thread's project. */
export function teamPreferencesPaletteAction(threadRef: ScopedThreadRef): CommandPaletteActionItem {
  return {
    kind: "action",
    value: "action:open-team-preferences",
    searchTerms: ["team preferences", "preferences", "instructions", "rules", "agents"],
    title: "Open team preferences",
    icon: <ScrollTextIcon className={ITEM_ICON_CLASS} />,
    run: async () => {
      useRightPanelStore.getState().open(threadRef, "preferences");
    },
  };
}
