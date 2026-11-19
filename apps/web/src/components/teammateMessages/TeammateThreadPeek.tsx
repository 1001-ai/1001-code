import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { resolveUserMessagePresentation } from "@t3tools/client-runtime/user-message";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import * as Option from "effect/Option";
import { MessagesSquareIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, type MouseEvent } from "react";
import { create } from "zustand";

import { cn } from "~/lib/utils";

import { useQuietThreadShell } from "../../state/entities";
import { useEnvironmentThread } from "../../state/threads";
import { buildThreadRouteParams } from "../../threadRoutes";
import ChatMarkdown from "../ChatMarkdown";
import {
  GLASS_CLASS,
  LIST_LANE_PADDING_CLASS,
  MOTION_EASING,
  MOTION_MS,
  VIEW_Z_INDEX,
} from "../chat/ExchangeThread";
import { coverLampChat } from "../lamp/lampLayer.logic";
import { Button } from "../ui/button";
import { Kbd } from "../ui/kbd";
import { Spinner } from "../ui/spinner";

interface PeekState {
  /** The timeline the glass covers, and the thread drawn on it. */
  readonly peek: { readonly overThreadKey: string; readonly target: ScopedThreadRef } | null;
}

const usePeekStore = create<PeekState>(() => ({ peek: null }));

export function openTeammateThreadPeek(overThreadKey: string, target: ScopedThreadRef): void {
  usePeekStore.setState({ peek: { overThreadKey, target } });
}

function closeTeammateThreadPeek(): void {
  usePeekStore.setState({ peek: null });
}

/** Messages shown; the thread itself is one click away for the rest. */
const PEEK_MESSAGE_LIMIT = 40;

/**
 * Another thread of this environment on the frosted glass the thread view uses, read-only, over
 * the timeline of `threadKey`. A routed teammate message's sender label opens it.
 */
export function TeammateThreadPeek(props: {
  readonly threadKey: string;
  readonly bottomInset: number;
  readonly topFadeEnabled: boolean;
}) {
  const peek = usePeekStore((state) => state.peek);
  const { threadKey } = props;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the peek store outlives this timeline; leaving the thread drops the peek opened over it
  useEffect(
    () => () =>
      usePeekStore.setState((state) =>
        state.peek?.overThreadKey === threadKey ? { peek: null } : state,
      ),
    [threadKey],
  );
  if (peek === null || peek.overThreadKey !== threadKey) return null;
  return (
    <TeammateThreadPeekView
      key={scopedThreadKey(peek.target)}
      target={peek.target}
      bottomInset={props.bottomInset}
      topFadeEnabled={props.topFadeEnabled}
    />
  );
}

const CONTENT_SELECTOR = "[data-teammate-peek-content]";

function TeammateThreadPeekView(props: {
  readonly target: ScopedThreadRef;
  readonly bottomInset: number;
  readonly topFadeEnabled: boolean;
}) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const glassRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const shell = useQuietThreadShell(props.target);
  const state = useEnvironmentThread(props.target.environmentId, props.target.threadId);
  const thread = Option.getOrNull(state.data);
  const messages = (thread?.messages ?? [])
    .flatMap((message) => {
      if (message.role === "system") return [];
      const presentation = resolveUserMessagePresentation(message);
      if (presentation.text.trim() === "") return [];
      const author =
        message.role === "assistant"
          ? "Agent"
          : presentation.attribution === null
            ? "You"
            : message.linkedSender?.title.trim() || "Agent";
      return [
        {
          id: message.id,
          own: message.role === "user" && presentation.attribution === null,
          author,
          text: presentation.text,
        },
      ];
    })
    .slice(-PEEK_MESSAGE_LIMIT);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- frosts the chat under the view, makes it inert and takes focus before the first paint, and gives all of it back on close
  useLayoutEffect(() => {
    const overlay = overlayRef.current;
    const glass = glassRef.current;
    const chat = overlay?.parentElement;
    if (!overlay || !glass || !chat) return;
    const before = document.activeElement;
    overlay.focus({ preventScroll: true });
    const timing = {
      duration: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : MOTION_MS,
      easing: MOTION_EASING,
    };
    const fades = [glass, overlay].map((element) =>
      element.animate([{ opacity: 0 }, { opacity: 1 }], timing),
    );
    const uncover = coverLampChat(chat, [overlay, glass], VIEW_Z_INDEX, timing);
    return () => {
      for (const fade of fades) fade.cancel();
      uncover();
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
      closeTeammateThreadPeek();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- starts at the newest message, as the thread itself does
  useLayoutEffect(() => {
    const overlay = overlayRef.current;
    if (overlay && messages.length > 0) overlay.scrollTop = overlay.scrollHeight;
  }, [messages.length]);

  const onBackdropClick = (event: MouseEvent<HTMLDivElement>) => {
    if (event.target instanceof Element && event.target.closest(CONTENT_SELECTOR)) return;
    if (document.getSelection()?.isCollapsed === false) return;
    closeTeammateThreadPeek();
  };

  const title = shell?.title.trim() || "Thread";
  return (
    <>
      <div
        ref={glassRef}
        aria-hidden="true"
        className={cn("pointer-events-none absolute inset-0 z-10", GLASS_CLASS)}
      />
      <div
        ref={overlayRef}
        data-teammate-peek=""
        role="region"
        aria-label={title}
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
            data-teammate-peek-content=""
            className="flex items-center gap-2 text-muted-foreground text-sm"
          >
            <MessagesSquareIcon className="size-4 shrink-0 text-foreground" />
            <span className="truncate font-medium text-foreground">{title}</span>
            <Button
              variant="ghost-muted"
              size="compact"
              onClick={() => {
                closeTeammateThreadPeek();
                void navigate({
                  to: "/$environmentId/$threadId",
                  params: buildThreadRouteParams(props.target),
                });
              }}
            >
              Open thread
            </Button>
            <span className="ms-auto flex shrink-0 items-center gap-1.5 text-xs">
              <Kbd variant="outline">Esc</Kbd> to close
            </span>
          </div>
          {thread === null ? (
            <div data-teammate-peek-content="" className="text-muted-foreground text-sm">
              {state.status === "deleted" || Option.isSome(state.error) ? (
                "This thread could not be loaded."
              ) : (
                <span className="flex items-center gap-2">
                  <Spinner /> Loading the thread
                </span>
              )}
            </div>
          ) : (
            <ol data-teammate-peek-content="" className="flex flex-col gap-4">
              {messages.map((message) => (
                <li
                  key={message.id}
                  className={cn("flex flex-col gap-1", message.own && "items-end")}
                >
                  <span className="text-muted-foreground text-xs">{message.author}</span>
                  <div
                    className={cn(
                      "min-w-0 max-w-[85%] text-foreground text-sm",
                      message.own && "rounded-2xl bg-secondary px-3 py-2",
                    )}
                  >
                    <ChatMarkdown
                      text={message.text}
                      cwd={undefined}
                      environmentId={props.target.environmentId}
                      threadRef={props.target}
                    />
                  </div>
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>
    </>
  );
}
