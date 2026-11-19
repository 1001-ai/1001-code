import { Toast } from "@base-ui/react/toast";
import { DownloadIcon } from "lucide-react";
import { useEffect, useRef } from "react";

import { APP_BASE_NAME } from "~/branding";
import { useDesktopSelfUpdateState } from "~/state/desktopSelfUpdate";
import { stackedThreadToast, type ThreadToastData, ToastProvider } from "../ui/toast";
import { RESTART_TO_UPDATE_LABEL, selfUpdateToast } from "./desktopSelfUpdateToast.logic";
import { useRestartToUpdate } from "./useRestartToUpdate";

// Its own region, so this one toast sits bottom-right while the app's others stay top-right.
const selfUpdateToastManager = Toast.createToastManager<ThreadToastData>();
let toastCount = 0;
const nextToastId = () => `desktop-self-update:${(toastCount += 1)}`;

/** The desktop app's own update, from the main process. Renders nothing on the web. */
export function DesktopSelfUpdateToast() {
  if (typeof window === "undefined" || !window.desktopBridge) return null;
  return (
    <>
      <ToastProvider position="bottom-right" toastManager={selfUpdateToastManager} />
      <SelfUpdateToastCoordinator />
    </>
  );
}

function SelfUpdateToastCoordinator() {
  const state = useDesktopSelfUpdateState();
  const { requestRestart, confirmDialog } = useRestartToUpdate();
  const shownToastId = useRef<string | null>(null);

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

  return confirmDialog;
}
