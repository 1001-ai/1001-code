import type { VoiceAgentInterruption } from "@t3tools/contracts";

/**
 * How the agent's streamed answer becomes speech. The answer arrives as the voice thread's
 * assistant messages, growing while they stream; the voice gets it a few whole sentences at a
 * time, so it starts talking before the answer is finished and never says half a sentence.
 */
export interface LampAgentMessage {
  readonly id: string;
  readonly text: string;
  readonly streaming: boolean;
}

export interface LampAgentFeed {
  /** How many characters of each message the voice has been given. */
  readonly given: Readonly<Record<string, number>>;
  /** Messages the user spoke over: whatever else arrives in them is never said. */
  readonly dropped: ReadonlySet<string>;
}

export const LAMP_AGENT_FEED_EMPTY: LampAgentFeed = { given: {}, dropped: new Set() };

/** Where a sentence that is still being written may be cut: after its end and a space. */
const SENTENCE_BREAK = /[.!?…]+["'”’)\]]*\s+|\n+/g;

/** The agent is told to write speech, but a model may still slip in markup: none of it is read out. */
export function speakable(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^\s*(?:[-*•]|#{1,6}|\d+\.)\s+/gm, "")
    .replace(/[*_`]+/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[ \t]+/g, " ")
    .trim();
}

/**
 * The next stretch of the answer to say, and the feed once it is given to the voice. Null when
 * there is nothing whole to say yet. A message that still streams gives only finished sentences.
 */
export function nextLampSpeech(
  feed: LampAgentFeed,
  messages: ReadonlyArray<LampAgentMessage>,
): { readonly text: string; readonly feed: LampAgentFeed } | null {
  const given: Record<string, number> = { ...feed.given };
  for (const message of messages) {
    if (feed.dropped.has(message.id)) continue;
    const from = given[message.id] ?? 0;
    const rest = message.text.slice(from);
    let length = rest.length;
    if (message.streaming) {
      length = 0;
      for (const match of rest.matchAll(SENTENCE_BREAK)) length = match.index + match[0].length;
      // The voice waits for this message's next sentence rather than skipping ahead of it.
      if (length === 0) return null;
    }
    given[message.id] = from + length;
    const text = speakable(rest.slice(0, length));
    if (text !== "") return { text, feed: { ...feed, given } };
  }
  return null;
}

/** What the agent has written and the voice has not been given. */
export function unsaidLampSpeech(
  feed: LampAgentFeed,
  messages: ReadonlyArray<LampAgentMessage>,
): string {
  return messages
    .flatMap((message) =>
      feed.dropped.has(message.id)
        ? []
        : [speakable(message.text.slice(feed.given[message.id] ?? 0))],
    )
    .filter((text) => text !== "")
    .join(" ");
}

/** The user has spoken: nothing more of the answer so far is said, however it goes on. */
export function lampSpeechDropped(
  feed: LampAgentFeed,
  messages: ReadonlyArray<LampAgentMessage>,
): LampAgentFeed {
  return {
    given: feed.given,
    dropped: new Set([...feed.dropped, ...messages.map((message) => message.id)]),
  };
}

const CONTEXT_MAX = 8_000;
const join = (...parts: ReadonlyArray<string>) => parts.filter((part) => part !== "").join(" ");

/**
 * What the agent is told when the user speaks before it had finished: what had been said aloud
 * and what had not. Undefined when the agent had nothing left to say, which is no interruption.
 * `saidBefore` is what the voice finished earlier in this answer, `cut` where the user stopped
 * the stretch being spoken, and `unsaid` what the voice had not been given yet.
 */
export function lampInterruptionContext(input: {
  readonly saidBefore: string;
  readonly cut: { readonly spoken: string; readonly unspoken: string } | null;
  readonly unsaid: string;
}): VoiceAgentInterruption | undefined {
  const unspoken = join(input.cut?.unspoken ?? "", input.unsaid);
  if (unspoken === "") return undefined;
  const spoken = join(input.saidBefore, input.cut?.spoken ?? "");
  return {
    // The newest of what was said and the nearest of what was not are what the agent needs.
    spoken: spoken.slice(-CONTEXT_MAX),
    unspoken: unspoken.slice(0, CONTEXT_MAX),
  };
}

const ACTIVE_RUN_STATUSES: ReadonlySet<string> = new Set([
  "preparing",
  "queued",
  "starting",
  "running",
  "waiting",
]);

/** Whether the agent is working on an answer. */
export function lampAgentRunning(runs: ReadonlyArray<{ readonly status: string }>): boolean {
  return runs.some((run) => ACTIVE_RUN_STATUSES.has(run.status));
}
