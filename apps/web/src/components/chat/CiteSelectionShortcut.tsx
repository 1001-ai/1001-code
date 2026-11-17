import { useAtomValue } from "@effect/atom-react";
import { useEffect } from "react";
import { useStableCallback } from "~/hooks/useStableCallback";
import { shortcutLabelForCommand } from "~/keybindings";
import { registerCommands } from "~/shortcuts/dispatcher";
import { primaryServerKeybindingsAtom } from "~/state/server";
import { Kbd } from "../ui/kbd";

/** Rendered inside the Cite button: binds `chat.citeSelection` while the button shows, and shows its key. */
export function CiteSelectionShortcut({
  onCite,
  hideHint,
}: {
  onCite: () => void;
  hideHint: boolean;
}) {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const cite = useStableCallback(onCite);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers the cite shortcut with the command registry while the Cite button is mounted
  useEffect(
    () =>
      // Capture phase: the Cite button stops key events it receives once Tab focuses it.
      registerCommands(
        {
          "chat.citeSelection": (event) => {
            event.preventDefault();
            if (!event.repeat) cite();
          },
        },
        { capture: true },
      ),
    [cite],
  );

  const label = hideHint ? null : shortcutLabelForCommand(keybindings, "chat.citeSelection");
  return label ? <Kbd>{label}</Kbd> : null;
}
