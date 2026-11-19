import type { DesktopSelfUpdateState } from "@t3tools/contracts";

import type { DesktopSelfUpdateCheck } from "~/state/desktopSelfUpdate";
import type { DesktopUpdateStatusIconState } from "../sidebar/DesktopUpdateStatusIcon";
import { RESTART_TO_UPDATE_LABEL } from "./desktopSelfUpdateToast.logic";

const SCHEDULE = "Checks for a new version every hour.";
const CHECK_LABEL = "Check for Updates";
const CHECK_TOOLTIP = "Check for updates";

/** What Settings' version row and the sidebar's update button show for the app's own update. */
export interface SelfUpdateControls {
  /** What a click does; null while there is only waiting. */
  readonly action: "check" | "restart" | null;
  readonly description: string;
  readonly label: string;
  readonly tooltip: string;
  /** A second tooltip line. */
  readonly detail: string | null;
  readonly icon: Extract<
    DesktopUpdateStatusIconState,
    "idle" | "checking" | "downloading" | "downloaded"
  >;
}

/** Null when the build names no update command, so upstream's controls stay as they are. */
export function selfUpdateControls(
  state: DesktopSelfUpdateState | null,
  check: DesktopSelfUpdateCheck,
): SelfUpdateControls | null {
  if (state === null || state.status === "off") return null;
  if (state.status === "ready") {
    return {
      action: "restart",
      description:
        state.restartError === undefined
          ? "A new version is ready."
          : `Update failed: ${state.restartError}`,
      label: RESTART_TO_UPDATE_LABEL,
      tooltip: RESTART_TO_UPDATE_LABEL,
      detail: state.restartError ?? null,
      icon: "downloaded",
    };
  }
  if (state.status === "building") {
    return {
      action: null,
      description: "Building the new version.",
      label: "Building…",
      tooltip: "Building update…",
      detail: null,
      icon: "downloading",
    };
  }
  if (check === "checking") {
    return {
      action: null,
      description: SCHEDULE,
      label: "Checking…",
      tooltip: "Checking for updates…",
      detail: null,
      icon: "checking",
    };
  }
  if (state.status === "error") {
    return {
      action: "check",
      description: `Update failed: ${state.message}`,
      label: CHECK_LABEL,
      tooltip: CHECK_TOOLTIP,
      detail: state.message,
      icon: "idle",
    };
  }
  // `idle` after a check that found nothing still means nothing newer was found.
  const upToDate = check === "up-to-date";
  return {
    action: "check",
    description: upToDate ? `Up to date. ${SCHEDULE}` : SCHEDULE,
    label: CHECK_LABEL,
    tooltip: CHECK_TOOLTIP,
    detail: upToDate ? "Up to date." : null,
    icon: "idle",
  };
}
