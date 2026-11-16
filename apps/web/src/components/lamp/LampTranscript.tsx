import type { EnvironmentId, ThreadId, VoiceAgentSession } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from "react";

import { cn } from "~/lib/utils";
import { useVoiceAgentState, useVoiceAgentTranscript } from "~/state/voiceAgent";

import { agentsBoardTime } from "../agentsBoard/agentsBoard.logic";
import {
  GLASS_CLASS,
  LIST_LANE_PADDING_CLASS,
  MOTION_EASING,
  MOTION_MS,
} from "../chat/ExchangeThread";
import { Button } from "../ui/button";
import { Kbd } from "../ui/kbd";
import { Spinner } from "../ui/spinner";
import { LampIcon } from "./LampIcon";
import { LAMP_NAME } from "./lampLayer.logic";
import { closeLampTranscript, openLampTranscript } from "./lampLayer.state";
import { lampTranscriptCards, lampTranscriptSummary } from "./lampTranscript.logic";

/**
 * A chat's closed voice conversations, as cards at the end of its timeline. A conversation shows
 * here only once its layer has closed, and only if something was said: the server lists no other.
 */
export function LampTranscriptCards(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly threadKey: string;
}) {
  const sessions = useVoiceAgentState(props.environmentId, props.threadId)?.sessions ?? [];
  const [showAll, setShowAll] = useState(false);
  const { shown, earlier } = lampTranscriptCards(sessions, showAll);
  if (shown.length === 0) return null;
  return (
    <div className="messages-timeline-row-frame">
      <div className="chat-content-lane flex flex-col items-start gap-1.5 py-2">
        {earlier > 0 ? (
          <Button variant="ghost" size="xs" onClick={() => setShowAll(true)}>
            Show {earlier} earlier voice {earlier === 1 ? "conversation" : "conversations"}
          </Button>
        ) : null}
        {shown.map((session) => (
          <LampTranscriptCard key={session.id} session={session} threadKey={props.threadKey} />
        ))}
      </div>
    </div>
  );
}

function LampTranscriptCard(props: {
  readonly session: VoiceAgentSession;
  readonly threadKey: string;
}) {
  return (
    <button
      type="button"
      data-lamp-transcript-card={props.session.id}
      className="flex w-full max-w-md items-center gap-3 rounded-lg border border-border bg-card px-3 py-2 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      onClick={() => openLampTranscript(props.threadKey, props.session.id)}
    >
      <LampIcon className="size-4 shrink-0 text-muted-foreground" />
      <span className="flex min-w-0 flex-col">
        <span className="font-medium text-foreground text-sm">Voice conversation</span>
        <span className="truncate text-muted-foreground text-xs">
          {lampTranscriptSummary(props.session, agentsBoardTime)}
        </span>
      </span>
      <span className="ms-auto shrink-0 text-muted-foreground text-xs">View transcript</span>
    </button>
  );
}

const CONTENT_SELECTOR = "[data-lamp-transcript-content]";

/**
 * One voice conversation as a conversation, on the frosted glass the thread view uses: the
 * user's turns on the right, the agent's on the left. The message list stays mounted underneath.
 */
export function LampTranscriptView(props: {
  readonly environmentId: EnvironmentId;
  readonly sessionId: string;
  readonly bottomInset: number;
  readonly topFadeEnabled: boolean;
}) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const glassRef = useRef<HTMLDivElement>(null);
  const result = useVoiceAgentTranscript(props.environmentId, props.sessionId);
  const transcript = AsyncResult.getOrElse(result, () => null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- frosts the chat under the view, makes it inert and takes focus before the first paint, and gives all of it back on close
  useLayoutEffect(() => {
    const overlay = overlayRef.current;
    const glass = glassRef.current;
    const chat = overlay?.parentElement;
    if (!overlay || !glass || !chat) return;
    const before = document.activeElement;
    overlay.focus({ preventScroll: true });
    const duration = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : MOTION_MS;
    const fades = [glass, overlay].map((element) =>
      element.animate([{ opacity: 0 }, { opacity: 1 }], { duration, easing: MOTION_EASING }),
    );
    const covered = [...chat.children].filter(
      (child): child is HTMLElement =>
        child instanceof HTMLElement &&
        child !== overlay &&
        child !== glass &&
        !child.hasAttribute("inert"),
    );
    for (const element of covered) element.setAttribute("inert", "");
    return () => {
      for (const fade of fades) fade.cancel();
      for (const element of covered) element.removeAttribute("inert");
      if (before instanceof HTMLElement && before.isConnected) {
        before.focus({ preventScroll: true });
      }
    };
  }, []);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Escape closes the view from anywhere in the chat, unless something else handled it
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
      event.preventDefault();
      closeLampTranscript();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const onBackdropClick = (event: MouseEvent<HTMLDivElement>) => {
    if (event.target instanceof Element && event.target.closest(CONTENT_SELECTOR)) return;
    if (document.getSelection()?.isCollapsed === false) return;
    closeLampTranscript();
  };

  return (
    <>
      <div
        ref={glassRef}
        aria-hidden="true"
        className={cn("pointer-events-none absolute inset-0 z-10", GLASS_CLASS)}
      />
      <div
        ref={overlayRef}
        data-lamp-transcript=""
        role="region"
        aria-label="Voice conversation transcript"
        tabIndex={-1}
        className={cn(
          "absolute inset-0 z-10 flex flex-col overflow-y-auto overscroll-y-contain outline-none",
          LIST_LANE_PADDING_CLASS,
        )}
        onClick={onBackdropClick}
      >
        {props.topFadeEnabled ? (
          <div className="h-[var(--workspace-titlebar-scroll-fade-height)] shrink-0" />
        ) : null}
        <div
          className="chat-content-lane flex flex-1 flex-col gap-4 pt-4"
          style={{ paddingBottom: props.bottomInset + 16 }}
        >
          <div
            data-lamp-transcript-content=""
            className="flex items-center gap-2 text-muted-foreground text-sm"
          >
            <LampIcon className="size-4 shrink-0 text-foreground" />
            <span className="font-medium text-foreground">{LAMP_NAME}</span>
            {transcript ? (
              <>
                <span aria-hidden="true">·</span>
                <span>{agentsBoardTime(transcript.openedAt)}</span>
              </>
            ) : null}
            <span className="ms-auto flex items-center gap-1.5 text-xs">
              <Kbd variant="outline">Esc</Kbd> to close
            </span>
          </div>
          {transcript === null ? (
            <div data-lamp-transcript-content="" className="text-muted-foreground text-sm">
              {result._tag === "Failure" ? (
                "This transcript could not be loaded."
              ) : (
                <span className="flex items-center gap-2">
                  <Spinner /> Loading the transcript
                </span>
              )}
            </div>
          ) : (
            <ol data-lamp-transcript-content="" className="flex flex-col gap-3">
              {transcript.turns.map((turn) => (
                <li
                  // A turn is one speaker's words from one moment on.
                  key={`${turn.at}:${turn.role}`}
                  className={cn("flex flex-col gap-1", turn.role === "user" && "items-end")}
                >
                  <span className="text-muted-foreground text-xs">
                    {turn.role === "user" ? "You" : LAMP_NAME}
                  </span>
                  <p
                    className={cn(
                      "max-w-[85%] whitespace-pre-wrap text-foreground text-sm",
                      turn.role === "user" && "rounded-2xl bg-secondary px-3 py-2",
                    )}
                  >
                    {turn.text}
                  </p>
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>
    </>
  );
}
