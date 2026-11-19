import { type ReactNode, useState } from "react";

import { useMediaQuery } from "~/hooks/useMediaQuery";
import { cn } from "~/lib/utils";
import { useDesktopSelfUpdateCheck, useDesktopSelfUpdateState } from "~/state/desktopSelfUpdate";
import { DesktopUpdateStatusIcon } from "../sidebar/DesktopUpdateStatusIcon";
import { Button } from "../ui/button";
import { SidebarMenuItem } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { selfUpdateControls } from "./desktopSelfUpdateControls.logic";
import { useRestartToUpdate } from "./useRestartToUpdate";

function useSelfUpdateControls() {
  const { check, checkNow } = useDesktopSelfUpdateCheck();
  const { requestRestart, confirmDialog } = useRestartToUpdate();
  const controls = selfUpdateControls(useDesktopSelfUpdateState(), check);
  const act = () => {
    if (controls?.action === "check") checkNow();
    if (controls?.action === "restart") requestRestart();
  };
  return { controls, act, confirmDialog };
}

/** True in a desktop build that names an update command, once the main process has said so. */
export function useDesktopSelfUpdateOn(): boolean {
  const status = useDesktopSelfUpdateState()?.status;
  return status !== undefined && status !== "off";
}

/** Props that replace the Settings version row's own while self-update is on; none otherwise. */
export function useDesktopSelfUpdateSettingsRow() {
  const { controls, act, confirmDialog } = useSelfUpdateControls();
  if (controls === null) return {};
  return {
    description: controls.description,
    managed: undefined,
    control: (
      <>
        <Button size="sm" variant="outline" disabled={controls.action === null} onClick={act}>
          {controls.label}
        </Button>
        {confirmDialog}
      </>
    ),
  };
}

/** The sidebar's update button while self-update is on. `children` keeps upstream's dialog mounted. */
export function DesktopSelfUpdateSidebarButton({ children }: { readonly children?: ReactNode }) {
  const { controls, act, confirmDialog } = useSelfUpdateControls();
  const prefersReducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const checking = controls?.icon === "checking";
  const canSpin = !prefersReducedMotion && (checking || controls?.icon === "idle");
  // Latched so a check always shows one whole turn and the turn under way finishes.
  const [spinning, setSpinning] = useState(false);
  const shouldSpin = canSpin && (checking || spinning);
  if (spinning !== shouldSpin) setSpinning(shouldSpin);
  if (controls === null) return null;

  const disabled = controls.action === null;
  const prominent = controls.icon === "downloading" || controls.icon === "downloaded";
  return (
    <SidebarMenuItem className="ml-auto shrink-0">
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label={
                controls.detail ? `${controls.tooltip}: ${controls.detail}` : controls.tooltip
              }
              aria-disabled={disabled || undefined}
              className={cn(
                "inline-flex size-8 items-center justify-center rounded-full outline-hidden ring-ring transition-colors focus-visible:ring-2 focus-visible:ring-inset",
                disabled ? "cursor-not-allowed" : "cursor-pointer",
                prominent
                  ? cn(
                      "bg-sidebar-control-surface text-sidebar-foreground",
                      !disabled && "hover:bg-sidebar-row-hover",
                    )
                  : cn(
                      "text-(--sidebar-icon-color)",
                      !disabled && "hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
                    ),
                disabled && !prominent && "opacity-60",
              )}
              onClick={act}
            >
              <DesktopUpdateStatusIcon
                isCheckAnimating={spinning}
                onCheckAnimationIteration={() => {
                  if (!checking) setSpinning(false);
                }}
                status={spinning ? "checking" : controls.icon}
              />
            </button>
          }
        />
        <TooltipPopup
          align="center"
          side="top"
          variant={prominent && !controls.detail ? "glass" : "default"}
        >
          {controls.detail ? (
            <div className="text-left">
              <div className="font-medium">{controls.tooltip}</div>
              <div className="text-muted-foreground">{controls.detail}</div>
            </div>
          ) : (
            controls.tooltip
          )}
        </TooltipPopup>
      </Tooltip>
      {confirmDialog}
      {children}
    </SidebarMenuItem>
  );
}
