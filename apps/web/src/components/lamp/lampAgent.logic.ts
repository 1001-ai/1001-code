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
  /** Words the voice was given and the user cut off, in an answer that goes on: said first. */
  readonly cutOff: string;
}

const join = (...parts: ReadonlyArray<string>) => parts.filter((part) => part !== "").join(" ");

export const LAMP_AGENT_FEED_EMPTY: LampAgentFeed = { given: {}, dropped: new Set(), cutOff: "" };

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
  if (feed.cutOff !== "") return { text: feed.cutOff, feed: { ...feed, cutOff: "" } };
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

/** What is still to say: the words the user cut off, then what the voice has not been given. */
export function unsaidLampSpeech(
  feed: LampAgentFeed,
  messages: ReadonlyArray<LampAgentMessage>,
): string {
  return join(
    feed.cutOff,
    ...messages.flatMap((message) =>
      feed.dropped.has(message.id)
        ? []
        : [speakable(message.text.slice(feed.given[message.id] ?? 0))],
    ),
  );
}

/** The user has spoken: nothing more of the answer so far is said, however it goes on. */
export function lampSpeechDropped(
  feed: LampAgentFeed,
  messages: ReadonlyArray<LampAgentMessage>,
): LampAgentFeed {
  return {
    given: feed.given,
    dropped: new Set([...feed.dropped, ...messages.map((message) => message.id)]),
    cutOff: "",
  };
}

const CONTEXT_MAX = 8_000;

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

/** The answer in progress, as the voice has it. */
export interface LampAnswer {
  readonly feed: LampAgentFeed;
  /** What the voice finished of the answer, and all of it when no voice can speak. */
  readonly saidBefore: string;
}

/**
 * The user has spoken over the answer: `answer` says nothing more of it, and `interruption`
 * goes to the agent with their words. If those never reach the agent it goes on with its answer,
 * and `undone` gives the voice back what this took, starting at the words the user cut off.
 */
export function lampSpokenOver(
  answer: LampAnswer,
  messages: ReadonlyArray<LampAgentMessage>,
  cut: { readonly spoken: string; readonly unspoken: string } | null,
): {
  readonly answer: LampAnswer;
  readonly interruption: VoiceAgentInterruption | undefined;
  readonly undone: (now: LampAnswer) => LampAnswer;
} {
  const taken = new Set(
    messages.flatMap((message) => (answer.feed.dropped.has(message.id) ? [] : [message.id])),
  );
  return {
    answer: { feed: lampSpeechDropped(answer.feed, messages), saidBefore: "" },
    interruption: lampInterruptionContext({
      saidBefore: answer.saidBefore,
      cut,
      unsaid: unsaidLampSpeech(answer.feed, messages),
    }),
    undone: (now) => ({
      feed: {
        given: now.feed.given,
        dropped: new Set([...now.feed.dropped].filter((id) => !taken.has(id))),
        cutOff: join(cut?.unspoken ?? "", answer.feed.cutOff, now.feed.cutOff),
      },
      saidBefore: join(answer.saidBefore, cut?.spoken ?? "", now.saidBefore),
    }),
  };
}

/** The user's sends that are on their way, and the failed ones whose effect may still be undone. */
export interface LampSays {
  readonly started: number;
  readonly inFlight: number;
  /** Whether the send started last reached the agent; it decides for the ones before it. */
  readonly latestDelivered: boolean;
  readonly failed: ReadonlyArray<{
    readonly order: number;
    readonly undone: (now: LampAnswer) => LampAnswer;
  }>;
}

export const NO_LAMP_SAYS: LampSays = {
  started: 0,
  inFlight: 0,
  latestDelivered: true,
  failed: [],
};

export function lampSayStarted(says: LampSays): {
  readonly says: LampSays;
  readonly order: number;
} {
  const order = says.started + 1;
  return { says: { ...says, started: order, inFlight: says.inFlight + 1 }, order };
}

/**
 * A send came back. Nothing is undone while another is on its way. Once none is, the failed ones
 * are undone in the order they were sent, unless the last one sent reached the agent: it was
 * steered then, and an older answer handed back would be spoken over its new one.
 */
export function lampSaySettled(
  says: LampSays,
  order: number,
  delivered: boolean,
  undone: (now: LampAnswer) => LampAnswer,
): { readonly says: LampSays; readonly undo: ReadonlyArray<(now: LampAnswer) => LampAnswer> } {
  const inFlight = Math.max(0, says.inFlight - 1);
  const latestDelivered = order === says.started ? delivered : says.latestDelivered;
  const failed = delivered ? says.failed : [...says.failed, { order, undone }];
  if (inFlight > 0) return { says: { ...says, inFlight, latestDelivered, failed }, undo: [] };
  return {
    says: { ...says, inFlight, latestDelivered, failed: [] },
    undo: latestDelivered
      ? []
      : failed.toSorted((left, right) => left.order - right.order).map((entry) => entry.undone),
  };
}

/**
 * The project of the chat the layer covers. A new chat has no thread on the server until its
 * first message, so its project is its draft's.
 */
export function lampChatProjectId<Id>(
  thread: { readonly projectId: Id } | null,
  draft: { readonly projectId: Id } | null,
): Id | null {
  return thread?.projectId ?? draft?.projectId ?? null;
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
