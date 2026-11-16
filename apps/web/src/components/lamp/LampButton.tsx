import { useAtomValue } from "@effect/atom-react";

import { cn } from "~/lib/utils";

import { shortcutLabelForCommand } from "../../keybindings";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { useMobileSidebarSheetMounted } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { LampIcon } from "./LampIcon";
import { LAMP_NAME } from "./lampLayer.logic";
import { toggleLampLayer, useLampLayerOpen, useLampThread } from "./lampLayer.state";

/** The lamp's amber, the feature's one colour that is not a theme token. Set on each root. */
export const LAMP_ACCENT_CLASS = "[--lamp-amber:oklch(0.769_0.188_70.08)]";

// The header keeps this much room for the button: its width and the gap to the next control.
const BUTTON_SIZE_CLASS = "h-8 w-8 sm:h-7 sm:w-20";
const HEADER_ROOM_CLASS = "w-9 sm:w-21";

/**
 * Opens and closes the layer over one thread's chat. Wider than the square toggles beside it,
 * with a resting glow that is static; only hover moves, and only for a moment.
 */
export function LampButton({ threadKey }: { readonly threadKey: string }) {
  useLampThread(threadKey);
  const open = useLampLayerOpen(threadKey);
  const shortcutLabel = shortcutLabelForCommand(
    useAtomValue(primaryServerKeybindingsAtom),
    "lamp.toggle",
  );
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="me-1 flex shrink-0" />}>
        <button
          type="button"
          data-lamp-button=""
          aria-pressed={open}
          aria-label={`Toggle ${LAMP_NAME}`}
          onClick={toggleLampLayer}
          className={cn(
            "group/lamp relative isolate inline-flex shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-lg border font-medium text-sm outline-none select-none [-webkit-app-region:no-drag]",
            LAMP_ACCENT_CLASS,
            BUTTON_SIZE_CLASS,
            "border-(--lamp-amber)/40 bg-(--lamp-amber)/10 hover:border-(--lamp-amber)/60 hover:bg-(--lamp-amber)/16",
            "motion-safe:transition-colors motion-safe:duration-200 motion-safe:ease-out",
            "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
            "aria-pressed:border-(--lamp-amber)/70 aria-pressed:bg-(--lamp-amber)/24 aria-pressed:inset-shadow-sm",
            // The glow: a blurred copy of the button behind it. Hover changes only its opacity
            // and scale, so the blur is painted once and never animates.
            "before:pointer-events-none before:absolute before:inset-0 before:-z-10 before:rounded-[inherit] before:bg-(--lamp-amber)/50 before:opacity-60 before:blur-sm",
            "motion-safe:before:transition-[opacity,scale] motion-safe:before:duration-200 motion-safe:before:ease-out",
            "hover:before:scale-115 hover:before:opacity-100 aria-pressed:before:opacity-100",
          )}
        >
          <LampIcon className="size-4 shrink-0 text-(--lamp-amber) motion-safe:transition-transform motion-safe:duration-200 motion-safe:ease-out motion-safe:group-hover/lamp:scale-110 motion-safe:group-hover/lamp:-rotate-12" />
          <span className="hidden sm:inline">{LAMP_NAME}</span>
        </button>
      </TooltipTrigger>
      <TooltipPopup side="bottom">
        {`Toggle ${LAMP_NAME}${shortcutLabel ? ` (${shortcutLabel})` : ""}`}
      </TooltipPopup>
    </Tooltip>
  );
}

/**
 * The chat header's share: room for the button so the breadcrumb stops short of it, and the
 * button itself while the right panel owns the title bar and only the thread details toggle
 * stays at the header's end.
 */
export function LampHeaderEntry({
  threadKey,
  inHeader,
}: {
  readonly threadKey: string;
  readonly inHeader: boolean;
}) {
  const mobileSidebarSheetMounted = useMobileSidebarSheetMounted();
  return (
    <>
      <span aria-hidden="true" className={cn("shrink-0", HEADER_ROOM_CLASS)} />
      {inHeader ? (
        <div
          className={cn(
            "absolute top-[var(--workspace-controls-top)] right-[calc(env(safe-area-inset-right)+0.75rem+var(--workspace-titlebar-control-size))] z-50 flex h-[var(--workspace-topbar-height)] items-center",
            mobileSidebarSheetMounted && "hidden",
          )}
          data-workspace-titlebar-controls
        >
          <LampButton threadKey={threadKey} />
        </div>
      ) : null}
    </>
  );
}
