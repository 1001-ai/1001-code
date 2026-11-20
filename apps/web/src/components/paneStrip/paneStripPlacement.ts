import * as Schema from "effect/Schema";

import { useLocalStorage } from "../../hooks/useLocalStorage";
import type { RightPanelSurface } from "../../rightPanelStore";
import {
  orderPaneStripSurfaces,
  PANE_STRIP_PLACEMENT_STORAGE_KEY,
} from "./paneStripPlacement.logic";

const PlacementSchema = Schema.Literals(["outward", "fixed"]);

/** Per browser, like the pane strip switch: no settings or contract change. */
export function usePaneStripPlacement() {
  return useLocalStorage(PANE_STRIP_PLACEMENT_STORAGE_KEY, "outward", PlacementSchema);
}

/** The thread's panes in the order the strip draws them. */
export function usePaneStripOrder(surfaces: ReadonlyArray<RightPanelSurface>) {
  const [placement] = usePaneStripPlacement();
  return orderPaneStripSurfaces(surfaces, placement);
}
