import { describe, expect, it } from "vite-plus/test";

import {
  LAMP_AGENT_FEED_EMPTY,
  lampAgentRunning,
  lampInterruptionContext,
  lampSpeechDropped,
  nextLampSpeech,
  speakable,
  unsaidLampSpeech,
  type LampAgentFeed,
  type LampAgentMessage,
} from "./lampAgent.logic";

const message = (id: string, text: string, streaming = false): LampAgentMessage => ({
  id,
  text,
  streaming,
});

/** Everything the voice is given for these messages, stretch by stretch. */
function spoken(feed: LampAgentFeed, messages: ReadonlyArray<LampAgentMessage>) {
  const said: Array<string> = [];
  let current = feed;
  for (
    let next = nextLampSpeech(current, messages);
    next;
    next = nextLampSpeech(current, messages)
  ) {
    said.push(next.text);
    current = next.feed;
  }
  return { said, feed: current };
}

describe("feeding the agent's streamed answer to the voice", () => {
  it("gives the voice whole sentences while the answer streams, and the rest when it ends", () => {
    let feed = LAMP_AGENT_FEED_EMPTY;
    // Half a sentence is not said.
    expect(nextLampSpeech(feed, [message("a", "Sam's agent two is", true)])).toBeNull();

    const first = nextLampSpeech(feed, [
      message("a", "Sam's agent two is blocked. It needs a rev", true),
    ]);
    expect(first?.text).toBe("Sam's agent two is blocked.");
    feed = first!.feed;
    // Nothing new is whole yet.
    expect(
      nextLampSpeech(feed, [
        message("a", "Sam's agent two is blocked. It needs a review of", true),
      ]),
    ).toBeNull();

    const second = nextLampSpeech(feed, [
      message("a", "Sam's agent two is blocked. It needs a review of the token change", false),
    ]);
    expect(second?.text).toBe("It needs a review of the token change");
    expect(
      nextLampSpeech(second!.feed, [
        message("a", "Sam's agent two is blocked. It needs a review of the token change", false),
      ]),
    ).toBeNull();
  });

  it("says the messages in order, waits for one that still streams, and skips empty ones", () => {
    const messages = [
      message("a", "Kim's agent one is done."),
      message("b", "   "),
      message("c", "Robin's agent three", true),
      message("d", "This comes after."),
    ];
    const { said, feed } = spoken(LAMP_AGENT_FEED_EMPTY, messages);
    // The later message waits: saying it first would put the answer out of order.
    expect(said).toEqual(["Kim's agent one is done."]);
    expect(unsaidLampSpeech(feed, messages)).toBe("Robin's agent three This comes after.");
  });

  it("reads no markup aloud", () => {
    expect(
      speakable("**Sam's** agent `two`:\n- is _blocked_\n## Next\n1. [a link](https://x.test)"),
    ).toBe("Sam's agent two:\nis blocked\nNext\na link");
    expect(nextLampSpeech(LAMP_AGENT_FEED_EMPTY, [message("a", "```\ncode\n```")])).toBeNull();
  });

  it("says nothing more of an answer the user spoke over, and all of the next one", () => {
    const before = [message("a", "One. Two. Three.", true)];
    const first = nextLampSpeech(LAMP_AGENT_FEED_EMPTY, before);
    const dropped = lampSpeechDropped(first!.feed, before);
    const after = [
      message("a", "One. Two. Three. Four.", false),
      message("b", "You asked who is blocked."),
    ];
    expect(spoken(dropped, after).said).toEqual(["You asked who is blocked."]);
    expect(unsaidLampSpeech(dropped, after)).toBe("You asked who is blocked.");
  });
});

describe("telling the agent where the user cut in", () => {
  it("joins what was said aloud and what was not, across the stretches of one answer", () => {
    expect(
      lampInterruptionContext({
        saidBefore: "Kim's agent one is done.",
        cut: { spoken: "Sam's agent two", unspoken: "is blocked." },
        unsaid: "It needs a review.",
      }),
    ).toEqual({
      spoken: "Kim's agent one is done. Sam's agent two",
      unspoken: "is blocked. It needs a review.",
    });
    // Between two stretches, or while the answer is still being written: nothing was cut mid-word.
    expect(lampInterruptionContext({ saidBefore: "One.", cut: null, unsaid: "Two." })).toEqual({
      spoken: "One.",
      unspoken: "Two.",
    });
  });

  it("is no interruption when the agent had finished", () => {
    expect(
      lampInterruptionContext({ saidBefore: "All of it.", cut: null, unsaid: "" }),
    ).toBeUndefined();
    expect(
      lampInterruptionContext({
        saidBefore: "",
        cut: { spoken: "All of it.", unspoken: "" },
        unsaid: "",
      }),
    ).toBeUndefined();
  });
});

it("is working while a run of the voice thread is under way", () => {
  expect(lampAgentRunning([{ status: "completed" }, { status: "running" }])).toBe(true);
  expect(lampAgentRunning([{ status: "completed" }, { status: "interrupted" }])).toBe(false);
  expect(lampAgentRunning([])).toBe(false);
});
