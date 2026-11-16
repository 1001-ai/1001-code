import { parseScopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
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
import { VoiceWaveform } from "../chat/VoiceInputPill";
import { VoiceInputSetup } from "../chat/VoiceInputSetup";
import { Button } from "../ui/button";
import { Kbd } from "../ui/kbd";
import { LampIcon } from "./LampIcon";
import { LAMP_NAME, afterLampMotion } from "./lampLayer.logic";
import { closeLampLayer, useLampLayerOpen, useLampTranscriptOpen } from "./lampLayer.state";
import { LampMediaPlayer } from "./LampMediaPlayer";
import { LAMP_STATUS_LABEL, captionParts, stoppedAfterLine } from "./lampSpeech.logic";
import { LampTranscriptCards, LampTranscriptView } from "./LampTranscript";
import { useLampVoice } from "./useLampVoice";

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
  /** The timeline has no rows, so it draws no list for the cards to end. */
  readonly empty: boolean;
}): { readonly open: boolean; readonly element: ReactNode; readonly cards: ReactNode } {
  const open = useLampLayerOpen(input.threadKey);
  // The thread's environment runs the agent, and dictation asks it for the user's vocabulary.
  const thread = parseScopedThreadKey(input.threadKey);
  const transcript = useLampTranscriptOpen(input.threadKey);
  const cards = thread ? (
    <LampTranscriptCards
      environmentId={thread.environmentId}
      threadId={thread.threadId}
      threadKey={input.threadKey}
    />
  ) : null;
  return {
    open: open || transcript !== null,
    element: thread ? (
      <>
        {input.empty ? <div className="absolute inset-x-0 top-0 pt-4">{cards}</div> : null}
        {/* Keyed by thread, so a switch drops an open layer at once instead of playing its exit. */}
        <LampLayerPresence
          key={input.threadKey}
          open={open}
          threadKey={input.threadKey}
          environmentId={thread.environmentId}
          threadId={thread.threadId}
          bottomInset={input.bottomInset}
          topFadeEnabled={input.topFadeEnabled}
        />
        {transcript !== null && !open ? (
          <LampTranscriptView
            key={transcript}
            environmentId={thread.environmentId}
            sessionId={transcript}
            bottomInset={input.bottomInset}
            topFadeEnabled={input.topFadeEnabled}
          />
        ) : null}
      </>
    ) : null,
    /** The chat's closed voice conversations, for the end of its timeline's list. */
    cards: input.empty ? null : cards,
  };
}

function LampLayerPresence(props: {
  readonly open: boolean;
  readonly threadKey: string;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
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
      threadKey={props.threadKey}
      environmentId={props.environmentId}
      threadId={props.threadId}
      bottomInset={props.bottomInset}
      topFadeEnabled={props.topFadeEnabled}
    />
  );
}

/** How far inside the layer's visible band the word being spoken stays. */
const CAPTION_SCROLL_MARGIN = 48;

/**
 * A frosted layer over the chat, where the voice agent speaks with live captions, listens while
 * Space is held, and shows the screenshots it is asked for. Like the thread view, it sits beside
 * the message list, which stays mounted and untouched underneath, and it moves only while it
 * opens and closes.
 */
function LampLayerView({
  closing,
  onClosed,
  threadKey,
  environmentId,
  threadId,
  bottomInset,
  topFadeEnabled,
}: {
  readonly closing: boolean;
  readonly onClosed: () => void;
  readonly threadKey: string;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly bottomInset: number;
  readonly topFadeEnabled: boolean;
}) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const glassRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const spokenWordRef = useRef<HTMLSpanElement>(null);
  const focusBeforeOpenRef = useRef<HTMLElement | null>(null);
  const voice = useLampVoice({
    environmentId,
    threadId,
    threadKey,
    closing,
    openDurationMs: motionDuration,
  });
  const { said, interruption, heard } = voice.session;
  const { speech } = voice;
  const caption = said ? captionParts(said) : null;
  const listening = voice.status === "listening";
  const recording = speech.state.phase === "preparing" || speech.state.phase === "recording";
  const spokenWordStart = caption && caption.current !== "" ? caption.spoken.length : null;
  // A model that streams sends the user's words as they are said; others send them at the end.
  const live =
    speech.preview && speech.preview.committed + speech.preview.tentative !== ""
      ? speech.preview
      : null;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- scrolls the layer so the word being spoken stays in view above the prompt box
  useEffect(() => {
    const overlay = overlayRef.current;
    const word = spokenWordRef.current;
    if (!overlay || !word || spokenWordStart === null) return;
    const view = overlay.getBoundingClientRect();
    const top = view.top + CAPTION_SCROLL_MARGIN;
    const bottom = view.bottom - bottomInset - CAPTION_SCROLL_MARGIN;
    const rect = word.getBoundingClientRect();
    if (rect.top >= top && rect.bottom <= bottom) return;
    // A third of the way down, so the rest of the sentence shows under the word.
    overlay.scrollBy({
      top: rect.top - (top + Math.max(0, bottom - top) / 3),
      behavior: motionDuration() === 0 ? "auto" : "smooth",
    });
  }, [spokenWordStart, bottomInset]);

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
        if (hidden) {
          hidden.cancel();
          // An empty keyframe is the element's own CSS opacity: it fades back in as the glass clears.
          element.animate([{ opacity: 0 }, {}], timing);
        }
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
    const cancel = afterLampMotion(moves, timing.duration, () => finishClose(overlay));
    return () => {
      cancel();
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
            <span role="status">{LAMP_STATUS_LABEL[voice.status]}</span>
          </div>
          <div className="flex flex-1 flex-col items-center justify-center gap-8">
            {closing ? null : <LampMediaPlayer environmentId={environmentId} threadId={threadId} />}
            {caption ? (
              <div data-lamp-layer-content="" className="flex flex-col items-center gap-3">
                {/* Said, being said, still to come. Only the word's place changes as it speaks. */}
                <p className="max-w-[28ch] whitespace-pre-line text-balance text-center font-medium text-2xl sm:text-3xl">
                  <span className="text-foreground">{caption.spoken}</span>
                  <span
                    ref={spokenWordRef}
                    className={cn(
                      "text-foreground",
                      // Padding and an equal negative margin: the highlight moves no text.
                      spokenWordStart !== null &&
                        "-mx-0.5 rounded-sm bg-primary/25 box-decoration-clone px-0.5",
                    )}
                  >
                    {caption.current}
                  </span>
                  <span className="text-muted-foreground/60">{caption.upcoming}</span>
                </p>
                {interruption ? (
                  <p className="text-muted-foreground text-xs">{stoppedAfterLine(interruption)}</p>
                ) : null}
              </div>
            ) : null}
            {listening || heard !== null ? (
              <div
                data-lamp-layer-content=""
                className="flex max-w-[48ch] flex-col items-center gap-2 text-center"
              >
                <div className="flex items-center gap-2 font-medium text-muted-foreground text-xs">
                  <span>You</span>
                  {recording ? (
                    <span className="flex w-16">
                      <VoiceWaveform level={speech.level} />
                    </span>
                  ) : null}
                </div>
                {live ? (
                  <p className="text-foreground text-lg">
                    {live.committed}
                    <span className="text-muted-foreground">{live.tentative}</span>
                  </p>
                ) : listening ? (
                  <p className="text-lg text-muted-foreground">
                    {recording ? "Listening…" : "Transcribing…"}
                  </p>
                ) : (
                  <p className="text-foreground text-lg">{heard}</p>
                )}
              </div>
            ) : null}
          </div>
          <div
            data-lamp-layer-content=""
            className="flex items-center justify-between gap-4 text-muted-foreground text-xs"
          >
            {voice.notice ? (
              <span role="status" className="flex min-w-0 items-center gap-2">
                <span className="min-w-0">{voice.notice.text}</span>
                {voice.notice.action ? (
                  <span className="shrink-0">
                    <Button variant="outline" size="compact" onClick={voice.notice.action.run}>
                      {voice.notice.action.label}
                    </Button>
                  </span>
                ) : null}
              </span>
            ) : listening ? (
              <span className="flex items-center gap-1.5">
                <Kbd variant="outline">Space</Kbd> to finish
              </span>
            ) : (
              <span className="flex items-center gap-1.5">
                {voice.holdToTalk ? "Hold" : "Press"} <Kbd variant="outline">Space</Kbd> to talk
              </span>
            )}
            <span className="flex shrink-0 items-center gap-1.5">
              <Kbd variant="outline">Esc</Kbd> to {listening ? "cancel" : "close"}
            </span>
          </div>
        </div>
      </div>
      <VoiceInputSetup
        environmentId={speech.transcriptionEnvironmentId}
        open={speech.setup.open}
        step={speech.setup.step}
        status={speech.status}
        model={speech.setup.model}
        language={speech.setup.language}
        downloading={speech.setup.downloading}
        error={speech.setup.error}
        onOpenChange={speech.setup.setOpen}
        onRetryCatalog={speech.setup.retryCatalog}
        onDownload={() => void speech.setup.download()}
        onCancelDownload={() => void speech.setup.cancelDownload()}
        onStartRecording={() => void speech.setup.startRecording()}
      />
    </>
  );
}
