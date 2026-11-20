import type { ProjectMoment, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  addPaneStripArrivals,
  INITIAL_PANE_STRIP_NUDGE_WATCH,
  type PaneStripNudgeInput,
  type PaneStripNudgeWatch,
  watchPaneStripArrivals,
} from "./paneStripNudge.logic";

const OPEN = "open" as ThreadId;
const INBOX = "inbox" as ThreadId;

const moment = (id: string, minute: number, threadId = "other"): ProjectMoment =>
  ({
    id,
    kind: "done",
    threadId: threadId as ThreadId,
    threadTitle: `Title ${id}`,
    at: new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString(),
    messageId: null,
    snippet: "",
  }) as ProjectMoment;

const message = (id: string, role: "user" | "assistant") => ({
  id,
  role,
  text: `  Hello\n ${id} `,
});
const inbox = (latest: ReturnType<typeof message> | null, running = false) => ({
  threadId: INBOX,
  running,
  latestMessage: latest,
});

const input = (overrides: Partial<PaneStripNudgeInput>): PaneStripNudgeInput => ({
  moments: [moment("a", 1)],
  inbox: inbox(message("m1", "assistant")),
  openThreadId: OPEN,
  paneOnScreen: false,
  ...overrides,
});

/** Runs each input through the watch, as the nudge does on each render, and collects arrivals. */
function run(steps: ReadonlyArray<Partial<PaneStripNudgeInput>>) {
  let watch: PaneStripNudgeWatch = INITIAL_PANE_STRIP_NUDGE_WATCH;
  const labels: string[] = [];
  for (const step of steps) {
    const next = watchPaneStripArrivals(watch, input(step));
    watch = next.watch;
    labels.push(...next.arrivals.map((arrival) => `${arrival.label}: ${arrival.detail}`));
  }
  return labels;
}

describe("watchPaneStripArrivals", () => {
  it.each([
    { name: "first load shows nothing", steps: [{}], expected: [] },
    {
      name: "moments loading late are not new",
      steps: [{ moments: null }, { moments: [moment("a", 1), moment("b", 2)] }],
      expected: [],
    },
    {
      name: "a moment that arrives later is new",
      steps: [{}, { moments: [moment("a", 1), moment("b", 2)] }],
      expected: ["Implementation done: Title b"],
    },
    {
      name: "the first moment of an empty project is new",
      steps: [{ moments: [] }, { moments: [moment("a", 1)] }],
      expected: ["Implementation done: Title a"],
    },
    {
      name: "an older moment coming back is not new",
      steps: [{ moments: [moment("b", 2)] }, { moments: [moment("a", 1), moment("b", 2)] }],
      expected: [],
    },
    {
      name: "the open thread's moments do not nudge",
      steps: [{}, { moments: [moment("a", 1), moment("b", 2, OPEN)] }],
      expected: [],
    },
    {
      name: "the Inbox thread's moments do not nudge",
      steps: [{}, { moments: [moment("a", 1), moment("b", 2, INBOX)] }],
      expected: [],
    },
    {
      name: "nothing counts while the pane is on screen, and it stays seen",
      steps: [
        {},
        { moments: [moment("a", 1), moment("b", 2)], paneOnScreen: true },
        { moments: [moment("a", 1), moment("b", 2)] },
      ],
      expected: [],
    },
    {
      name: "a new Inbox reply is new",
      steps: [{}, { inbox: inbox(message("m2", "assistant")) }],
      expected: ["Inbox replied: Hello m2"],
    },
    {
      name: "the reader's own Inbox message is not",
      steps: [{}, { inbox: inbox(message("m2", "user")) }],
      expected: [],
    },
    {
      name: "the same Inbox message updating is not new again",
      steps: [
        {},
        { inbox: inbox(message("m2", "assistant")) },
        { inbox: inbox({ ...message("m2", "assistant"), text: "x" }) },
      ],
      expected: ["Inbox replied: Hello m2"],
    },
    {
      name: "a reply counts once its run ends",
      steps: [
        {},
        { inbox: inbox(message("m2", "assistant"), true) },
        { inbox: inbox({ ...message("m2", "assistant"), text: "Done" }) },
      ],
      expected: ["Inbox replied: Done"],
    },
    {
      name: "a reply already being written on first load is not new",
      steps: [
        { inbox: inbox(message("m2", "assistant"), true) },
        { inbox: inbox(message("m2", "assistant")) },
      ],
      expected: [],
    },
    {
      name: "an Inbox thread appearing later is not new",
      steps: [{ inbox: null }, { inbox: inbox(message("m1", "assistant")) }],
      expected: [],
    },
    {
      name: "an empty Inbox's first reply is new",
      steps: [{ inbox: inbox(null) }, { inbox: inbox(message("m1", "assistant")) }],
      expected: ["Inbox replied: Hello m1"],
    },
  ])("$name", ({ steps, expected }) => {
    expect(run(steps)).toEqual(expected);
  });

  it("keeps the same watch when nothing changed", () => {
    const first = watchPaneStripArrivals(INITIAL_PANE_STRIP_NUDGE_WATCH, input({})).watch;
    expect(watchPaneStripArrivals(first, input({})).watch).toBe(first);
  });
});

describe("addPaneStripArrivals", () => {
  const arrival = (label: string) => ({ kind: "moment" as const, label, detail: "" });

  it("counts up and shows the latest, one nudge at a time", () => {
    const first = addPaneStripArrivals(null, [arrival("a")]);
    expect(first).toEqual({ latest: arrival("a"), count: 1 });
    expect(addPaneStripArrivals(first, [arrival("b"), arrival("c")])).toEqual({
      latest: arrival("c"),
      count: 3,
    });
    expect(addPaneStripArrivals(first, [])).toBe(first);
  });
});
