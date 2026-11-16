import { useAtomValue } from "@effect/atom-react";

import { cn } from "~/lib/utils";

import { shortcutLabelForCommand } from "../../keybindings";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { LampIcon } from "./LampIcon";
import { LAMP_NAME, LAMP_NAME_IN_SENTENCE } from "./lampLayer.logic";
import { toggleLampLayer, useLampLayerOpen, useLampThread } from "./lampLayer.state";

/**
 * Opens and closes the layer over one thread's chat. As tall as the toggles beside it and two
 * and a half times as wide, icon centred, in the page's colours swapped. Only hover moves it.
 * `covered` is a maximized panel over the chat: the button keeps its place and does nothing.
 */
export function LampButton({
  threadKey,
  covered,
}: {
  readonly threadKey: string;
  readonly covered: boolean;
}) {
  useLampThread(threadKey, covered);
  const open = useLampLayerOpen(threadKey);
  const shortcutLabel = shortcutLabelForCommand(
    useAtomValue(primaryServerKeybindingsAtom),
    "lamp.toggle",
  );
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="ms-1 flex shrink-0" />}>
        <button
          type="button"
          data-lamp-button=""
          aria-pressed={open}
          aria-label={`Toggle ${LAMP_NAME_IN_SENTENCE}`}
          disabled={covered}
          onClick={toggleLampLayer}
          className={cn(
            "group/lamp relative isolate inline-flex h-8 w-20 shrink-0 cursor-pointer items-center justify-center rounded-lg bg-foreground text-background outline-none select-none sm:h-7 sm:w-17.5 [-webkit-app-region:no-drag]",
            "hover:bg-foreground/90 motion-safe:transition-colors motion-safe:duration-200 motion-safe:ease-out",
            "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background focus-visible:ring-inset",
            "aria-pressed:bg-foreground/80 aria-pressed:inset-shadow-sm aria-pressed:inset-shadow-background/40",
            "disabled:pointer-events-none disabled:opacity-50",
            // The glow: a blurred copy of the button behind it. Hover changes only its opacity
            // and scale, so the blur is painted once and never animates.
            "before:pointer-events-none before:absolute before:inset-0 before:-z-10 before:rounded-[inherit] before:bg-foreground/40 before:opacity-50 before:blur-sm",
            "motion-safe:before:transition-[opacity,scale] motion-safe:before:duration-200 motion-safe:before:ease-out",
            "hover:before:scale-125 hover:before:opacity-100 aria-pressed:before:opacity-100",
          )}
        >
          <LampIcon className="size-5 shrink-0 motion-safe:transition-transform motion-safe:duration-200 motion-safe:ease-out motion-safe:group-hover/lamp:scale-110 motion-safe:group-hover/lamp:-rotate-6" />
        </button>
      </TooltipTrigger>
      <TooltipPopup side="bottom">
        {covered
          ? `${LAMP_NAME} is unavailable`
          : `Toggle ${LAMP_NAME_IN_SENTENCE}${shortcutLabel ? ` (${shortcutLabel})` : ""}`}
      </TooltipPopup>
    </Tooltip>
  );
}

/** Room at the end of the chat header, the button and its gap, so the breadcrumb stops short of it. */
export function LampHeaderRoom() {
  return <span aria-hidden="true" className="w-21 shrink-0 sm:w-18.5" />;
}
