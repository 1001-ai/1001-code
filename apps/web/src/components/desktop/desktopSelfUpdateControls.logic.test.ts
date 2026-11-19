import type { DesktopSelfUpdateState } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { DesktopSelfUpdateCheck } from "~/state/desktopSelfUpdate";
import { type SelfUpdateControls, selfUpdateControls } from "./desktopSelfUpdateControls.logic";

const SCHEDULE = "Checks for a new version every hour.";
const FAILURE = "Could not check for an update: the update command did not run.";

describe("selfUpdateControls", () => {
  it.each<[DesktopSelfUpdateState | null, DesktopSelfUpdateCheck]>([
    [null, "none"],
    [{ status: "off" }, "none"],
    [{ status: "off" }, "checking"],
  ])("leaves upstream's controls alone for %j", (state, check) => {
    expect(selfUpdateControls(state, check)).toBeNull();
  });

  it.each<[DesktopSelfUpdateState, DesktopSelfUpdateCheck, SelfUpdateControls]>([
    [
      { status: "idle" },
      "none",
      {
        action: "check",
        description: SCHEDULE,
        label: "Check for Updates",
        tooltip: "Check for updates",
        detail: null,
        icon: "idle",
      },
    ],
    [
      { status: "idle" },
      "checking",
      {
        action: null,
        description: SCHEDULE,
        label: "Checking…",
        tooltip: "Checking for updates…",
        detail: null,
        icon: "checking",
      },
    ],
    [
      { status: "idle" },
      "up-to-date",
      {
        action: "check",
        description: `Up to date. ${SCHEDULE}`,
        label: "Check for Updates",
        tooltip: "Check for updates",
        detail: "Up to date.",
        icon: "idle",
      },
    ],
    [
      { status: "building" },
      // The check that found the update has not answered yet.
      "checking",
      {
        action: null,
        description: "Building the new version.",
        label: "Building…",
        tooltip: "Building update…",
        detail: null,
        icon: "downloading",
      },
    ],
    [
      { status: "ready" },
      "up-to-date",
      {
        action: "restart",
        description: "A new version is ready.",
        label: "Restart to update",
        tooltip: "Restart to update",
        detail: null,
        icon: "downloaded",
      },
    ],
    [
      { status: "ready", restartError: "Could not start the update: it did not run." },
      "none",
      {
        action: "restart",
        description: "Update failed: Could not start the update: it did not run.",
        label: "Restart to update",
        tooltip: "Restart to update",
        detail: "Could not start the update: it did not run.",
        icon: "downloaded",
      },
    ],
    [
      { status: "error", message: FAILURE },
      "up-to-date",
      {
        action: "check",
        description: `Update failed: ${FAILURE}`,
        label: "Check for Updates",
        tooltip: "Check for updates",
        detail: FAILURE,
        icon: "idle",
      },
    ],
    [
      { status: "error", message: FAILURE },
      "checking",
      {
        action: null,
        description: SCHEDULE,
        label: "Checking…",
        tooltip: "Checking for updates…",
        detail: null,
        icon: "checking",
      },
    ],
  ])("shows %j with check %s", (state, check, controls) => {
    expect(selfUpdateControls(state, check)).toEqual(controls);
  });
});
