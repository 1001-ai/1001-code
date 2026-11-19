import { FORK_DESKTOP } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as DesktopSelfUpdate from "../updates/DesktopSelfUpdate.ts";
import * as DesktopWindow from "./DesktopWindow.ts";

const NAME = FORK_DESKTOP.productName;
const NOTICE = "A notice offers Restart to update when it is ready.";

/**
 * Check for Updates when the build names an update command: the app's own updater answers instead
 * of upstream's, which this build keeps off. False, having done nothing, when there is no command.
 */
export const handleCheckForUpdatesClick = Effect.gen(function* () {
  const selfUpdate = yield* DesktopSelfUpdate.DesktopSelfUpdate;
  if (!(yield* selfUpdate.enabled)) return false;
  const dialog = yield* ElectronDialog.ElectronDialog;
  const info = (message: string, detail?: string) =>
    dialog.showMessageBox({
      type: "info",
      message,
      ...(detail === undefined ? {} : { detail }),
      buttons: ["OK"],
    });

  yield* (yield* DesktopWindow.DesktopWindow).activate;
  const result = yield* selfUpdate.checkNow;
  switch (result.status) {
    case "off":
      return false;
    case "ready": {
      const { response } = yield* dialog.showMessageBox({
        type: "info",
        message: "Update ready",
        detail: `A new version of ${NAME} is built. Restarting stops agents that are running. They continue when ${NAME} reopens if "Continue threads after restarts" is on in Settings.`,
        buttons: ["Restart to update", "Later"],
        defaultId: 0,
        cancelId: 1,
      });
      if (response === 0) yield* selfUpdate.restartToUpdate;
      break;
    }
    case "building":
    case "started":
      yield* info("Building the new version", NOTICE);
      break;
    case "checking":
      yield* info(
        "Already checking for updates",
        `If there is a new version, ${NAME} builds it. ${NOTICE}`,
      );
      break;
    case "up-to-date":
      yield* info(`${NAME} is up to date.`);
      break;
    case "error":
      yield* dialog.showMessageBox({
        type: "warning",
        message: "Update check failed",
        detail: result.message,
        buttons: ["OK"],
      });
      break;
  }
  return true;
}).pipe(Effect.withSpan("desktop.menu.selfUpdate.checkForUpdates"));
