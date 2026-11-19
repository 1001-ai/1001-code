import { useAtomValue } from "@effect/atom-react";
import { Toast } from "@base-ui/react/toast";
import type { DesktopBridge } from "@t3tools/contracts";
import { DownloadIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

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
import { stackedThreadToast, type ThreadToastData, ToastProvider } from "../ui/toast";
import {
  RESTART_TO_UPDATE_LABEL,
  type RestartConfirmation,
  restartConfirmation,
  selfUpdateToast,
} from "./desktopSelfUpdateToast.logic";

// Its own region, so this one toast sits bottom-right while the app's others stay top-right.
const selfUpdateToastManager = Toast.createToastManager<ThreadToastData>();
let toastCount = 0;
const nextToastId = () => `desktop-self-update:${(toastCount += 1)}`;

/** The desktop app's own update, from the main process. Renders nothing on the web. */
export function DesktopSelfUpdateToast() {
  const bridge = typeof window === "undefined" ? undefined : window.desktopBridge;
  if (!bridge) return null;
  return (
    <>
      <ToastProvider position="bottom-right" toastManager={selfUpdateToastManager} />
      <SelfUpdateToastCoordinator bridge={bridge} />
    </>
  );
}

function SelfUpdateToastCoordinator({ bridge }: { readonly bridge: DesktopBridge }) {
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
  const shownToastId = useRef<string | null>(null);

  // A false result leaves the toast up; the main process broadcasts the state that says why.
  const restart = () => {
    setConfirmOpen(false);
    void bridge.restartToUpdate();
  };
  const requestRestart = useStableCallback(() => {
    const next = restartConfirmation({ stopped, continuing, appName: APP_BASE_NAME });
    if (next === null) return restart();
    setConfirmation(next);
    setConfirmOpen(true);
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- replaces the imperative toastManager toast with the one for the main process's current update state
  useEffect(() => {
    if (shownToastId.current !== null) selfUpdateToastManager.close(shownToastId.current);
    shownToastId.current = null;
    const toast = selfUpdateToast(state, APP_BASE_NAME);
    if (toast === null) return;
    const id = nextToastId();
    const data: ThreadToastData = {
      // The corner button closes through the app's own manager, which does not hold this toast.
      onClose: () => selfUpdateToastManager.close(id),
    };
    const options =
      toast.kind === "error"
        ? stackedThreadToast({
            type: "error",
            title: toast.title,
            description: toast.description,
            timeout: 0,
            data,
          })
        : toast.kind === "building"
          ? stackedThreadToast({
              type: "info",
              title: toast.title,
              description: toast.description,
              timeout: 0,
              data: { ...data, leadingIcon: <DownloadIcon className="size-4 text-info" /> },
            })
          : stackedThreadToast({
              type: toast.restartError === undefined ? "success" : "error",
              title: toast.title,
              ...(toast.restartError === undefined ? {} : { description: toast.restartError }),
              timeout: 0,
              actionProps: { children: RESTART_TO_UPDATE_LABEL, onClick: requestRestart },
              data,
            });
    shownToastId.current = selfUpdateToastManager.add({
      ...options,
      id,
      onClose: () => {
        if (shownToastId.current === id) shownToastId.current = null;
      },
    });
  }, [state, requestRestart]);

  return (
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
}
