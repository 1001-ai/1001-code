import { SettingsRow } from "../settings/settingsLayout";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import type { PaneStripPlacement } from "./paneStripPlacement.logic";
import { usePaneStripPlacement } from "./paneStripPlacement";

const LABELS: Record<PaneStripPlacement, string> = {
  outward: "Open outward",
  fixed: "Fixed places",
};

/** Where new panes go in the strip. Saved in this browser, beside the strip's own switch. */
export function PaneStripPlacementRow() {
  const [placement, setPlacement] = usePaneStripPlacement();
  return (
    <SettingsRow
      id="pane-strip-placement"
      title="Pane placement"
      description="Open outward adds each new pane at the right end. Fixed places keeps every kind of pane in the same place: Files, Diff, Terminal, then Browser and the rest. Saved in this browser."
      control={
        <Select
          value={placement}
          onValueChange={(value) => {
            if (value === "outward" || value === "fixed") setPlacement(value);
          }}
        >
          <SelectTrigger size="sm" className="w-full sm:w-40" aria-label="Pane placement">
            <SelectValue>{LABELS[placement]}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            <SelectItem hideIndicator value="outward">
              {LABELS.outward}
            </SelectItem>
            <SelectItem hideIndicator value="fixed">
              {LABELS.fixed}
            </SelectItem>
          </SelectPopup>
        </Select>
      }
    />
  );
}
