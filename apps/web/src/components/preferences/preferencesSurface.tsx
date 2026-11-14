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
          label: "Preferences",
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

export function PreferencesSurfaceIcon() {
  return <ScrollTextIcon className="size-3 shrink-0" />;
}

/** The command palette's way to the preferences of the open thread's project. */
export function preferencesPaletteAction(threadRef: ScopedThreadRef): CommandPaletteActionItem {
  return {
    kind: "action",
    value: "action:open-preferences",
    searchTerms: ["preferences", "instructions", "rules", "agents"],
    title: "Open preferences",
    icon: <ScrollTextIcon className={ITEM_ICON_CLASS} />,
    run: async () => {
      useRightPanelStore.getState().open(threadRef, "preferences");
    },
  };
}
