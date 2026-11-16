import {
  type EnvironmentId,
  type ThreadId,
  VOICE_AGENT_SAID_MAX_LENGTH,
  type VoiceAgentInterruption,
  type VoiceAgentOpenResult,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { useEffect, useRef, useState } from "react";

import { useStableCallback } from "~/hooks/useStableCallback";
import { useEnvironmentThread } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import { voiceAgentClose, voiceAgentOpen, voiceAgentSay } from "~/state/voiceAgent";

import { lampAgentRunning, type LampAgentMessage } from "./lampAgent.logic";

const NOT_REACHED = "The voice agent could not be reached.";
const NO_MESSAGES: ReadonlyArray<LampAgentMessage> = [];

/** Where the layer stands with its agent: asking for it, talking to it, or told why it cannot. */
export type LampAgentLink = { readonly status: "opening" } | VoiceAgentOpenResult;

/**
 * The agent behind the layer. Opening the layer starts a conversation on the server and closing
 * it ends it; in between, the agent's answer is the hidden voice thread's assistant messages,
 * which stream here like any thread's.
 */
export function useLampAgent(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly closing: boolean;
}) {
  const { environmentId, threadId, closing } = input;
  const open = useStableCallback(useAtomCommand(voiceAgentOpen, { reportFailure: false }));
  const close = useStableCallback(useAtomCommand(voiceAgentClose, { reportFailure: false }));
  const send = useAtomCommand(voiceAgentSay, { reportFailure: false });
  const [link, setLink] = useState<LampAgentLink>({ status: "opening" });
  const [sending, setSending] = useState(false);
  const sessionId = useRef<string | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the conversation lives on the server: it starts when the layer opens and ends when the layer closes or unmounts
  useEffect(() => {
    if (closing) return;
    let live = true;
    void open({ environmentId, input: { threadId } }).then((result) => {
      const opened: VoiceAgentOpenResult =
        result._tag === "Success" ? result.value : { status: "unavailable", message: NOT_REACHED };
      if (opened.status === "ready") {
        // The layer closed while the server was opening the conversation: end it at once.
        if (!live) return void close({ environmentId, input: { sessionId: opened.sessionId } });
        sessionId.current = opened.sessionId;
      }
      if (live) setLink(opened);
    });
    return () => {
      live = false;
      const ended = sessionId.current;
      sessionId.current = null;
      if (ended !== null) void close({ environmentId, input: { sessionId: ended } });
      // The next open asks again.
      setLink({ status: "opening" });
    };
  }, [closing, environmentId, threadId, open, close]);

  const ready = link.status === "ready" ? link : null;
  const thread = Option.getOrNull(
    useEnvironmentThread(environmentId, ready?.voiceThreadId ?? null).data,
  );
  const openedAt = ready === null ? null : Date.parse(ready.openedAt);
  // The thread outlives the layer: only what the agent says in this conversation is spoken.
  const messages =
    thread === null || openedAt === null
      ? NO_MESSAGES
      : thread.messages.flatMap((message) =>
          message.role === "assistant" && DateTime.toEpochMillis(message.createdAt) >= openedAt
            ? [{ id: message.id, text: message.text, streaming: message.streaming }]
            : [],
        );

  const say = useStableCallback(
    async (text: string, interruption: VoiceAgentInterruption | undefined) => {
      const session = sessionId.current;
      if (session === null) return false;
      setSending(true);
      const result = await send({
        environmentId,
        input: {
          sessionId: session,
          text: text.slice(0, VOICE_AGENT_SAID_MAX_LENGTH),
          ...(interruption === undefined ? {} : { interruption }),
        },
      });
      setSending(false);
      return result._tag === "Success";
    },
  );

  return {
    link,
    messages,
    /** The agent is working on an answer, or is being asked for one. */
    working:
      !closing &&
      (link.status === "opening" || sending || (thread !== null && lampAgentRunning(thread.runs))),
    say,
  };
}
