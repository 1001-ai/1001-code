import { describe, expect, it } from "vite-plus/test";

import {
  LAMP_AGENT_FEED_EMPTY,
  NO_LAMP_SAYS,
  lampAgentRunning,
  lampChatProjectId,
  lampInterruptionContext,
  lampSaySettled,
  lampSayStarted,
  lampSpeechDropped,
  lampSpokenOver,
  nextLampSpeech,
  speakable,
  unsaidLampSpeech,
  type LampAgentFeed,
  type LampAnswer,
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

describe("the user's words not reaching the agent", () => {
  // The voice was given all three sentences, and the user cut in after the first.
  const cut = { spoken: "One.", unspoken: "Two. Three." };
  const heard = [message("a", "One. Two. Three. Fo", true)];
  const whole = [message("a", "One. Two. Three. Four.")];
  const given = nextLampSpeech(LAMP_AGENT_FEED_EMPTY, heard)!.feed;

  it("says nothing while they are on their way, then goes on from the words the user cut", () => {
    const over = lampSpokenOver({ feed: given, saidBefore: "Zero." }, heard, cut);
    expect(over.interruption).toEqual({ spoken: "Zero. One.", unspoken: "Two. Three. Fo" });
    expect(over.answer.saidBefore).toBe("");
    expect(spoken(over.answer.feed, whole).said).toEqual([]);

    const back = over.undone(over.answer);
    expect(back.saidBefore).toBe("Zero. One.");
    expect(spoken(back.feed, whole).said).toEqual(["Two. Three.", "Four."]);
    // Said again before the voice goes on, the agent is told what the lost words would have told it.
    expect(lampSpokenOver(back, heard, null).interruption).toEqual(over.interruption);
    // Said again and delivered, the answer is spoken over as it would have been.
    expect(spoken(lampSpokenOver(back, whole, null).answer.feed, whole).said).toEqual([]);
  });

  it("gives back only what each lost say took, in whichever order they are lost", () => {
    const later = [...heard, message("b", "Five.")];
    for (const firstLost of ["first", "second"] as const) {
      const first = lampSpokenOver({ feed: given, saidBefore: "" }, heard, cut);
      const second = lampSpokenOver(first.answer, later, null);
      const [one, two] = firstLost === "first" ? [first, second] : [second, first];
      const back = two.undone(one.undone(second.answer));
      expect(back.saidBefore).toBe("One.");
      expect(spoken(back.feed, [...whole, message("b", "Five.")]).said).toEqual([
        "Two. Three.",
        "Four.",
        "Five.",
      ]);
    }
    // The second say arrived: only what it took stays unsaid, and what came after it is said.
    const first = lampSpokenOver({ feed: given, saidBefore: "" }, heard, cut);
    const second = lampSpokenOver(first.answer, later, null);
    const answered = [...whole, message("b", "Five."), message("c", "You asked.")];
    expect(spoken(first.undone(second.answer).feed, answered).said).toEqual([
      "Two. Three.",
      "Four.",
      "You asked.",
    ]);
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

it("takes a new chat's project from its draft, and a sent chat's from its thread", () => {
  expect(lampChatProjectId(null, { projectId: "drafted" })).toBe("drafted");
  expect(lampChatProjectId({ projectId: "sent" }, { projectId: "drafted" })).toBe("sent");
  expect(lampChatProjectId(null, null)).toBeNull();
});

it("is working while a run of the voice thread is under way", () => {
  expect(lampAgentRunning([{ status: "completed" }, { status: "running" }])).toBe(true);
  expect(lampAgentRunning([{ status: "completed" }, { status: "interrupted" }])).toBe(false);
  expect(lampAgentRunning([])).toBe(false);
});

describe("which failed sends are undone", () => {
  const mark =
    (name: string) =>
    (now: LampAnswer): LampAnswer => ({
      ...now,
      saidBefore: `${now.saidBefore}${name}`,
    });
  const applied = (undo: ReadonlyArray<(now: LampAnswer) => LampAnswer>) =>
    undo.reduce<LampAnswer>((now, undone) => undone(now), {
      feed: LAMP_AGENT_FEED_EMPTY,
      saidBefore: "",
    }).saidBefore;

  it("undoes a lone failed send, and nothing after a delivered one", () => {
    const one = lampSayStarted(NO_LAMP_SAYS);
    expect(applied(lampSaySettled(one.says, one.order, false, mark("a")).undo)).toBe("a");
    expect(lampSaySettled(one.says, one.order, true, mark("a")).undo).toEqual([]);
  });

  it("never hands an old answer back over a later send that reached the agent", () => {
    const first = lampSayStarted(NO_LAMP_SAYS);
    const second = lampSayStarted(first.says);
    // The second is delivered while the first is still on its way; then the first fails.
    const afterSecond = lampSaySettled(second.says, second.order, true, mark("b"));
    expect(afterSecond.undo).toEqual([]);
    const afterFirst = lampSaySettled(afterSecond.says, first.order, false, mark("a"));
    expect(afterFirst.undo).toEqual([]);
    expect(afterFirst.says.failed).toEqual([]);
    // The other way round: the first fails first, then the second is delivered.
    const failedFirst = lampSaySettled(second.says, first.order, false, mark("a"));
    expect(failedFirst.undo).toEqual([]);
    expect(lampSaySettled(failedFirst.says, second.order, true, mark("b")).undo).toEqual([]);
  });

  it("undoes every failed send in the order sent, once none is on its way", () => {
    const first = lampSayStarted(NO_LAMP_SAYS);
    const second = lampSayStarted(first.says);
    const failedSecond = lampSaySettled(second.says, second.order, false, mark("b"));
    expect(failedSecond.undo).toEqual([]);
    expect(applied(lampSaySettled(failedSecond.says, first.order, false, mark("a")).undo)).toBe(
      "ab",
    );
    // An earlier send that was delivered does not excuse a later one that failed.
    const delivered = lampSaySettled(second.says, first.order, true, mark("a"));
    expect(applied(lampSaySettled(delivered.says, second.order, false, mark("b")).undo)).toBe("b");
  });
});
