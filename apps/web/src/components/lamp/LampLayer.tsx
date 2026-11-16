import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";

import { cn } from "~/lib/utils";

import {
  GLASS_CLASS,
  LIST_LANE_PADDING_CLASS,
  MOTION_EASING,
  MOTION_MS,
  VIEW_Z_INDEX,
} from "../chat/ExchangeThread";
import { Kbd } from "../ui/kbd";
import { LampIcon } from "./LampIcon";
import { LAMP_NAME } from "./lampLayer.logic";
import { closeLampLayer, useLampLayerOpen } from "./lampLayer.state";

/** Clicks on these are not clicks on the backdrop. */
const CONTENT_SELECTOR = "[data-lamp-layer-content]";

/** The prompt box of the chat the layer covers. It is drawn above the glass and stays usable. */
const PROMPT_BOX_SELECTOR = '[data-chat-composer-overlay="true"] [data-slot="composer-shell"]';
// On for as long as the layer is mounted, so the prompt box also moves on its way back.
const PROMPT_BOX_MOTION_CLASSES = [
  "origin-bottom",
  "motion-safe:transition-[transform,translate,scale,opacity]",
  "motion-safe:duration-300",
  "motion-safe:ease-out",
];
// Set back behind the glass: lower, tilted away on its bottom edge, smaller and fainter, until
// it is hovered, has focus or has a menu open. Reduced motion keeps only the fade. Receded, it
// hangs well below where it rests (it may leave the screen), so the strip under it (`after`)
// keeps it hovered while it returns.
const PROMPT_BOX_RECEDED_CLASSES = [
  "opacity-70",
  "motion-safe:translate-y-12",
  "motion-safe:scale-95",
  "motion-safe:transform-[perspective(800px)_rotateX(30deg)]",
  "hover:opacity-100",
  "hover:translate-y-0",
  "hover:scale-100",
  "hover:transform-[perspective(800px)_rotateX(0deg)]",
  "focus-within:opacity-100",
  "focus-within:translate-y-0",
  "focus-within:scale-100",
  "focus-within:transform-[perspective(800px)_rotateX(0deg)]",
  "has-data-popup-open:opacity-100",
  "has-data-popup-open:translate-y-0",
  "has-data-popup-open:scale-100",
  "has-data-popup-open:transform-[perspective(800px)_rotateX(0deg)]",
  "after:pointer-events-none",
  "after:absolute",
  "after:inset-x-0",
  "after:top-full",
  "after:h-14",
  "hover:after:pointer-events-auto",
];

function promptBoxUnder(overlay: HTMLElement | null) {
  return (
    overlay?.closest("[data-chat-column]")?.querySelector<HTMLElement>(PROMPT_BOX_SELECTOR) ?? null
  );
}

function motionDuration() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : MOTION_MS;
}

/**
 * The layer for one timeline: whether it is open, and the element that draws it. The element
 * goes wherever the timeline renders, so the layer also covers a thread with no messages.
 */
export function useLampLayer(input: {
  readonly threadKey: string;
  readonly bottomInset: number;
  readonly topFadeEnabled: boolean;
}): { readonly open: boolean; readonly element: ReactNode } {
  const open = useLampLayerOpen(input.threadKey);
  return {
    open,
    element: (
      // Keyed by thread, so a switch drops an open layer at once instead of playing its exit.
      <LampLayerPresence
        key={input.threadKey}
        open={open}
        bottomInset={input.bottomInset}
        topFadeEnabled={input.topFadeEnabled}
      />
    ),
  };
}

function LampLayerPresence(props: {
  readonly open: boolean;
  readonly bottomInset: number;
  readonly topFadeEnabled: boolean;
}) {
  // Stays mounted after the store closes it, until the exit has played.
  const [mounted, setMounted] = useState(props.open);
  if (props.open && !mounted) setMounted(true);
  if (!props.open && !mounted) return null;
  return (
    <LampLayerView
      closing={!props.open}
      onClosed={() => setMounted(false)}
      bottomInset={props.bottomInset}
      topFadeEnabled={props.topFadeEnabled}
    />
  );
}

/**
 * A frosted layer over the chat, where a voice agent that reports what other agents are doing
 * in the repository will speak and show its captions. For now it is the empty surface. Like the
 * thread view, it sits beside the message list, which stays mounted and untouched underneath,
 * and it moves only while it opens and closes.
 */
function LampLayerView({
  closing,
  onClosed,
  bottomInset,
  topFadeEnabled,
}: {
  readonly closing: boolean;
  readonly onClosed: () => void;
  readonly bottomInset: number;
  readonly topFadeEnabled: boolean;
}) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const glassRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const focusBeforeOpenRef = useRef<HTMLElement | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the prompt box is outside the layer, so its motion classes go on and come off with the layer
  useLayoutEffect(() => {
    const promptBox = promptBoxUnder(overlayRef.current);
    promptBox?.classList.add(...PROMPT_BOX_MOTION_CLASSES);
    return () => promptBox?.classList.remove(...PROMPT_BOX_MOTION_CLASSES);
  }, []);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- frosts the chat under the layer, sets its prompt box back and takes focus before the first paint, and again when a close is interrupted
  useLayoutEffect(() => {
    const overlay = overlayRef.current;
    const glass = glassRef.current;
    const content = contentRef.current;
    const chat = overlay?.parentElement;
    if (closing || !overlay || !glass || !content || !chat) return;
    const timing = { duration: motionDuration(), easing: MOTION_EASING };
    // The layer takes focus: the composer's editor consumes Escape, and would type a held Space.
    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== document.body && !overlay.contains(active)) {
      focusBeforeOpenRef.current = active;
    }
    overlay.focus({ preventScroll: true });
    const promptBox = promptBoxUnder(overlay);
    promptBox?.classList.add(...PROMPT_BOX_RECEDED_CLASSES);
    const covered = [...chat.children].flatMap((child) => {
      if (child === overlay || child === glass || !(child instanceof HTMLElement)) return [];
      child.setAttribute("inert", "");
      // Layers stacked above the glass, such as the timeline minimap, would stay sharp on top of it.
      const above = Number.parseInt(getComputedStyle(child).zIndex, 10) > VIEW_Z_INDEX;
      const hidden = above
        ? child.animate([{}, { opacity: 0 }], { ...timing, fill: "forwards" })
        : null;
      return [{ element: child, hidden }];
    });
    const moves = [
      glass.animate([{ opacity: 0 }, { opacity: 1 }], timing),
      content.animate(
        [
          { opacity: 0, transform: "translateY(8px)" },
          { opacity: 1, transform: "none" },
        ],
        timing,
      ),
    ];
    return () => {
      promptBox?.classList.remove(...PROMPT_BOX_RECEDED_CLASSES);
      for (const animation of moves) animation.cancel();
      for (const { element, hidden } of covered) {
        hidden?.cancel();
        element.removeAttribute("inert");
      }
    };
  }, [closing]);

  const finishClose = useEffectEvent((overlay: HTMLElement) => {
    const focusInLayer =
      document.activeElement === document.body || overlay.contains(document.activeElement);
    if (focusInLayer) {
      const before = focusBeforeOpenRef.current;
      const target = before?.isConnected
        ? before
        : document.querySelector<HTMLElement>("[data-lamp-button]");
      target?.focus({ preventScroll: true });
    }
    onClosed();
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- clears the glass and fades the content out, then unmounts
  useEffect(() => {
    const overlay = overlayRef.current;
    const glass = glassRef.current;
    const content = contentRef.current;
    if (!closing || !overlay || !glass || !content) return;
    const timing = { duration: motionDuration(), easing: MOTION_EASING, fill: "forwards" as const };
    const moves = [
      glass.animate([{ opacity: 1 }, { opacity: 0 }], timing),
      content.animate(
        [
          { opacity: 1, transform: "none" },
          { opacity: 0, transform: "translateY(8px)" },
        ],
        timing,
      ),
    ];
    let cancelled = false;
    void Promise.allSettled(moves.map((animation) => animation.finished)).then(() => {
      if (!cancelled) finishClose(overlay);
    });
    return () => {
      cancelled = true;
      for (const animation of moves) animation.cancel();
    };
  }, [closing]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Escape closes the layer from anywhere in the chat, unless something else handled it
  useEffect(() => {
    if (closing) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
      event.preventDefault();
      closeLampLayer();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closing]);

  const onBackdropClick = (event: MouseEvent<HTMLDivElement>) => {
    if (event.target instanceof Element && event.target.closest(CONTENT_SELECTOR)) return;
    if (document.getSelection()?.isCollapsed === false) return;
    closeLampLayer();
  };

  return (
    <>
      {/* A sibling of the content, so opening and closing fade it by opacity without animating the blur. */}
      <div
        ref={glassRef}
        aria-hidden="true"
        className={cn("pointer-events-none absolute inset-0 z-10", GLASS_CLASS)}
      />
      <div
        ref={overlayRef}
        data-lamp-layer=""
        role="region"
        aria-label={LAMP_NAME}
        tabIndex={-1}
        className={cn(
          "absolute inset-0 z-10 flex flex-col overflow-y-auto overscroll-y-contain outline-none",
          LIST_LANE_PADDING_CLASS,
        )}
        onClick={onBackdropClick}
      >
        {topFadeEnabled ? (
          <div className="h-[var(--workspace-titlebar-scroll-fade-height)] shrink-0" />
        ) : null}
        <div
          ref={contentRef}
          className="chat-content-lane flex flex-1 flex-col gap-6 pt-4"
          style={{ paddingBottom: bottomInset + 16 }}
        >
          <div
            data-lamp-layer-content=""
            className="flex items-center gap-2 self-start text-muted-foreground text-sm"
          >
            <LampIcon className="size-4 shrink-0 text-foreground" />
            <span className="font-medium text-foreground">{LAMP_NAME}</span>
            <span aria-hidden="true">·</span>
            <span>Idle</span>
          </div>
          {/* Where live captions of what the agent says will appear. */}
          <div className="flex flex-1 items-center justify-center">
            <p
              data-lamp-layer-content=""
              className="max-w-[24ch] text-balance text-center font-medium text-2xl text-foreground sm:text-3xl"
            >
              Nothing to report.
            </p>
          </div>
          <div
            data-lamp-layer-content=""
            className="flex items-center justify-between gap-4 text-muted-foreground text-xs"
          >
            <span className="flex items-center gap-1.5">
              Hold <Kbd variant="outline">Space</Kbd> to talk
            </span>
            <span className="flex items-center gap-1.5">
              <Kbd variant="outline">Esc</Kbd> to close
            </span>
          </div>
        </div>
      </div>
    </>
  );
}
