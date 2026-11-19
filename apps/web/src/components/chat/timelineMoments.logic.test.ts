import {
  type AgentsBoardData,
  MessageId,
  PROJECT_MOMENTS_LIMIT,
  type ProjectMoment,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { MessagesTimelineRow } from "./MessagesTimeline.logic";
import {
  applyProjectMomentsItem,
  EMPTY_PROJECT_MOMENTS,
  findMessageRow,
  mergeMomentCards,
  resolveMomentCardsVisible,
  teammateMomentCards,
  momentStackEntries,
} from "./timelineMoments.logic";

const threadId = ThreadId.make("thread:exports");
const at = (day: number, hour: number) => new Date(2026, 10, day, hour).toISOString();

const moment = (
  id: string,
  when: string,
  overrides: Partial<ProjectMoment> = {},
): ProjectMoment => ({
  id,
  kind: "thread-started",
  threadId,
  threadTitle: "Exports",
  at: when,
  messageId: MessageId.make(`message:${id}`),
  snippet: "Add the export button",
  sender: { kind: "user", title: null },
  ...overrides,
});

const agentMessage = (
  id: string,
  agentId: string,
  status: "started" | "working" | "blocked" | "question" | "done",
  when: string,
) =>
  ({
    _tag: "agent",
    id,
    agentId,
    at: when,
    status,
    text: `${agentId} ${status}`,
    branch: null,
    pr: status === "done" ? "https://github.com/acme/app/pull/7" : null,
    next: null,
    needs: null,
    media: [],
  }) as const;

const board = (messages: AgentsBoardData["messages"]): AgentsBoardData => ({
  agents: [
    {
      id: "ada-1",
      owner: "ada",
      tool: null,
      task: null,
      started: null,
      latestStatus: null,
      latestAt: null,
      needs: null,
    },
    {
      id: "sam-2",
      owner: "Sam",
      tool: null,
      task: null,
      started: null,
      latestStatus: null,
      latestAt: null,
      needs: null,
    },
    {
      id: "ada-power-9",
      owner: "ada-power",
      tool: null,
      task: null,
      started: null,
      latestStatus: null,
      latestAt: null,
      needs: null,
    },
    {
      id: "lin-3",
      owner: null,
      tool: null,
      task: null,
      started: null,
      latestStatus: null,
      latestAt: null,
      needs: null,
    },
  ],
  messages,
  activeCount: 0,
  needsPersonCount: 0,
  truncated: false,
});

describe("applyProjectMomentsItem", () => {
  it("keeps moments ordered through upserts and removals", () => {
    let state = applyProjectMomentsItem(EMPTY_PROJECT_MOMENTS, {
      kind: "snapshot",
      moments: [moment("a", at(17, 9)), moment("c", at(17, 11))],
      truncated: false,
    });
    state = applyProjectMomentsItem(state, { kind: "upsert", moment: moment("b", at(17, 10)) });
    state = applyProjectMomentsItem(state, {
      kind: "upsert",
      moment: moment("a", at(17, 12), { snippet: "Edited" }),
    });
    expect(state.moments.map((entry) => entry.id)).toEqual(["b", "c", "a"]);
    state = applyProjectMomentsItem(state, { kind: "remove", id: "c" });
    expect(state.moments.map((entry) => entry.id)).toEqual(["b", "a"]);
    state = applyProjectMomentsItem(state, { kind: "remove-thread", threadId });
    expect(state.moments).toEqual([]);
  });

  it("keeps only as many of the newest moments as a snapshot holds", () => {
    let state = applyProjectMomentsItem(EMPTY_PROJECT_MOMENTS, {
      kind: "snapshot",
      moments: Array.from({ length: PROJECT_MOMENTS_LIMIT }, (_, index) =>
        moment(`m${index}`, new Date(Date.parse(at(17, 9)) + index * 1000).toISOString()),
      ),
      truncated: false,
    });
    state = applyProjectMomentsItem(state, { kind: "upsert", moment: moment("new", at(17, 12)) });
    expect(state.moments).toHaveLength(PROJECT_MOMENTS_LIMIT);
    expect(state.moments[0]?.id).toBe("m1");
    expect(state.moments.at(-1)?.id).toBe("new");
  });
});

describe("teammateMomentCards", () => {
  const messages = [
    agentMessage("m1", "ada-1", "question", at(17, 9)),
    agentMessage("m2", "sam-2", "question", at(17, 10)),
    agentMessage("m3", "sam-2", "working", at(17, 11)),
    agentMessage("m4", "sam-2", "done", at(17, 12)),
    agentMessage("m5", "lin-3", "started", at(17, 13)),
    agentMessage("m6", "ada-7", "blocked", at(17, 14)),
    agentMessage("m7", "ada-power-9", "question", at(17, 15)),
  ];

  it("leaves out the viewer's own agents by owner or agent id, and working updates", () => {
    const cards = teammateMomentCards(board(messages), "ADA");
    expect(cards.map((card) => [card.label, card.person, card.pullRequestUrl])).toEqual([
      ["Agent asked a question", "Sam", null],
      ["Agent is done", "Sam", "https://github.com/acme/app/pull/7"],
      ["Agent started", "A teammate", null],
      ["Agent asked a question", "ada-power", null],
    ]);
  });

  it("keeps every agent when no one is signed in", () => {
    expect(teammateMomentCards(board(messages), null)).toHaveLength(6);
  });
});

describe("mergeMomentCards", () => {
  const teammates = teammateMomentCards(
    board([
      agentMessage("m1", "sam-2", "done", at(17, 10)),
      agentMessage("m0", "sam-2", "done", at(1, 10)),
    ]),
    "ada",
  );
  const input = {
    moments: [
      moment("stale", at(1, 9)),
      moment("a", at(17, 9)),
      moment("b", at(17, 11), {
        kind: "pr-testing",
        pullRequest: { number: 4, url: "u", title: null },
      }),
    ],
    teammates,
    sinceMillis: Date.parse(at(10, 0)),
  };

  it("orders this project's and teammates' cards together, indenting only personal ones", () => {
    const cards = mergeMomentCards({ ...input, showTeammates: true });
    expect(cards.map((card) => [card.label, card.personal])).toEqual([
      ["Thread started", true],
      ["Agent is done", false],
      ["PR #4 is in testing", true],
    ]);
  });

  it("hides teammates when the toggle is off", () => {
    const cards = mergeMomentCards({ ...input, showTeammates: false });
    expect(cards.map((card) => card.personal)).toEqual([true, true]);
  });
});

describe("momentStackEntries", () => {
  it("starts each local day with Today, Yesterday or its date, and names each person's run", () => {
    const cards = mergeMomentCards({
      moments: [
        moment("a", at(15, 9)),
        moment("b", at(17, 9)),
        moment("c", at(18, 7)),
        moment("d", at(18, 9)),
        moment("e", at(18, 10)),
      ],
      teammates: teammateMomentCards(board([agentMessage("s", "sam-2", "done", at(18, 8))]), "ada"),
      showTeammates: true,
      sinceMillis: 0,
    });
    const entries = momentStackEntries(cards, Date.parse(at(18, 12)));
    expect(
      entries.map((entry) =>
        entry.kind === "day" ? entry.label : [entry.card.id, entry.groupName],
      ),
    ).toEqual([
      new Date(2026, 10, 15).toLocaleDateString(undefined, {
        weekday: "short",
        month: "short",
        day: "numeric",
      }),
      ["a", "You"],
      "Yesterday",
      ["b", "You"],
      "Today",
      ["c", "You"],
      ["board:s", "Sam"],
      ["d", "You"],
      ["e", null],
    ]);
  });
});

describe("resolveMomentCardsVisible", () => {
  it.each([
    [199, false, false],
    [200, false, true],
    [193, true, true],
    [191, true, false],
  ])("a %d px gutter, shown before: %s, shows cards: %s", (gutter, visible, expected) => {
    expect(resolveMomentCardsVisible(gutter, visible)).toBe(expected);
  });
});

describe("findMessageRow", () => {
  it("finds the loaded row showing a message", () => {
    const rows = [
      { kind: "message", id: "row:1", message: { id: "message:1" } },
      { kind: "message", id: "row:2", message: { id: "message:2" } },
    ] as unknown as ReadonlyArray<MessagesTimelineRow>;
    expect(findMessageRow(rows, "message:2")).toEqual({ rowId: "row:2", rowIndex: 1 });
    expect(findMessageRow(rows, "message:9")).toBeNull();
  });
});
