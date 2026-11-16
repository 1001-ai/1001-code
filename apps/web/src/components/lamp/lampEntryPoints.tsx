import { dispatchCommandPalette } from "../../commandPaletteStore";
import { type CommandPaletteActionItem, ITEM_ICON_CLASS } from "../CommandPalette.logic";
import { LampIcon } from "./LampIcon";
import { LAMP_NAME } from "./lampLayer.logic";
import {
  readCanToggleLampLayer,
  toggleLampLayer,
  useLampLayerToggleState,
} from "./lampLayer.state";

/** The `lamp.toggle` shortcut. With no thread on screen it leaves the key to others. */
export function lampToggleCommand(event: KeyboardEvent): boolean | void {
  if (!readCanToggleLampLayer()) return false;
  event.preventDefault();
  event.stopPropagation();
  if (event.repeat) return;
  dispatchCommandPalette({ _tag: "SetOpen", open: false });
  toggleLampLayer();
}

/** The command palette's way to the layer, offered while a thread is on screen. */
export function useLampPaletteAction(): CommandPaletteActionItem | null {
  const state = useLampLayerToggleState();
  if (state === null) return null;
  return {
    kind: "action",
    value: "action:lamp",
    searchTerms: ["lamp", "voice", "talk", "listen", "agents", "report", "narrate"],
    title: state === "open" ? `Close ${LAMP_NAME}` : `Open ${LAMP_NAME}`,
    icon: <LampIcon className={ITEM_ICON_CLASS} />,
    shortcutCommand: "lamp.toggle",
    run: async () => {
      toggleLampLayer();
    },
  };
}
