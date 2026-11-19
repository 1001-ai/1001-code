import { SettingsRow } from "../settings/settingsLayout";
import { Switch } from "../ui/switch";
import { usePaneStripSetting } from "./paneStripMode";

/** The Labs switch for the pane strip. It is saved in this browser, not on the server. */
export function PaneStripRow() {
  const [enabled, setEnabled] = usePaneStripSetting();
  return (
    <SettingsRow
      id="pane-strip"
      title="Pane strip"
      description="Show a thread's panes side by side instead of as tabs. Swipe sideways to move between them; the project's Inbox sits one swipe to the left of the thread. Saved in this browser."
      control={
        <Switch
          checked={enabled}
          onCheckedChange={(checked) => setEnabled(Boolean(checked))}
          aria-label="Pane strip"
        />
      }
    />
  );
}
