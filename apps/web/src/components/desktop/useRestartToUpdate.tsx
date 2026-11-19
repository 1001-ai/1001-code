import { useAtomValue } from "@effect/atom-react";
import { useState } from "react";

import { APP_BASE_NAME } from "~/branding";
import { useStableCallback } from "~/hooks/useStableCallback";
import { useDesktopSelfUpdateState } from "~/state/desktopSelfUpdate";
import { useEnvironments } from "~/state/environments";
import { runningThreadCountAtom } from "../sidebar/UpdateEverythingDialog";
import { isHostedByThisApp } from "../sidebar/useUpdateEverything";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import {
  RESTART_TO_UPDATE_LABEL,
  type RestartConfirmation,
  restartConfirmation,
} from "./desktopSelfUpdateToast.logic";

/**
 * Restart to update for every control that offers it: `requestRestart` asks first when agents are
 * running on a server this app hosts, in the `confirmDialog` the caller renders.
 */
export function useRestartToUpdate() {
  const state = useDesktopSelfUpdateState();
  const { environments } = useEnvironments();
  // Quitting stops every backend this app hosts. Count only while a restart is on offer.
  const hosted = state?.status === "ready" ? environments.filter(isHostedByThisApp) : [];
  const continues = (environment: (typeof hosted)[number]) =>
    environment.serverConfig?.settings.continueThreadsAfterServerUpdate === true;
  const continuing = useAtomValue(
    runningThreadCountAtom(
      hosted
        .filter(continues)
        .map((environment) => environment.environmentId)
        .join("\n"),
    ),
  );
  const stopped = useAtomValue(
    runningThreadCountAtom(
      hosted
        .filter((environment) => !continues(environment))
        .map((environment) => environment.environmentId)
        .join("\n"),
    ),
  );
  const [confirmation, setConfirmation] = useState<RestartConfirmation | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  // A false result changes nothing here; the main process broadcasts the state that says why.
  const restart = () => {
    setConfirmOpen(false);
    void window.desktopBridge?.restartToUpdate();
  };
  const requestRestart = useStableCallback(() => {
    const next = restartConfirmation({ stopped, continuing, appName: APP_BASE_NAME });
    if (next === null) return restart();
    setConfirmation(next);
    setConfirmOpen(true);
  });

  const confirmDialog = (
    <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>{confirmation?.title}</AlertDialogTitle>
          <AlertDialogDescription>{confirmation?.description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
          <Button onClick={restart}>{RESTART_TO_UPDATE_LABEL}</Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
  return { requestRestart, confirmDialog };
}
