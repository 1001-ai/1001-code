import {
  type AgentsBoardData,
  type OrchestrationV2AppThreadLineage,
  MessageId,
  PROJECT_MOMENTS_LIMIT,
  type ProjectMoment,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { MessagesTimelineRow } from "./MessagesTimeline.logic";
import {
  agentsBoardMomentCards,
  applyProjectMomentsItem,
  EMPTY_PROJECT_MOMENTS,
  findMessageRow,
  mergeMomentCards,
  resolveMomentCardsVisible,
  momentStackEntries,
  newestMomentArrival,
  resolveMomentCardMaxWidth,
  singleThreadBranches,
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
  branch: string | null = null,
) =>
  ({
    _tag: "agent",
    id,
    agentId,
    at: when,
    status,
    text: `${agentId} ${status}`,
    branch,
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
      id: "adalove-4",
      owner: "Ada Lovelace",
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

const lineage = (overrides: Partial<OrchestrationV2AppThreadLineage> = {}) => ({
  parentThreadId: null,
  relationshipToParent: null,
  rootThreadId: threadId,
  ...overrides,
});

describe("agentsBoardMomentCards", () => {
  const messages = [
    agentMessage("m1", "ada-1", "question", at(17, 9)),
    agentMessage("m2", "sam-2", "question", at(17, 10)),
    agentMessage("m3", "sam-2", "working", at(17, 11)),
    agentMessage("m4", "sam-2", "done", at(17, 12)),
    agentMessage("m5", "lin-3", "started", at(17, 13)),
    agentMessage("m6", "ada-7", "blocked", at(17, 14)),
    agentMessage("m7", "ada-power-9", "question", at(17, 15)),
    agentMessage("m8", "adalove-4", "done", at(17, 16)),
  ];

  it("puts the viewer's own agents under You by board name, whole or first word, or agent id", () => {
    // The login matches no owner: agents write their person's name, not the GitHub login.
    const cards = agentsBoardMomentCards(board(messages), { login: "octo-ada", name: "Ada" });
    expect(cards.map((card) => [card.label, card.person, card.personal])).toEqual([
      ["Agent asked a question", "You", true],
      ["Agent asked a question", "Sam", false],
      ["Agent is done", "Sam", false],
      ["Agent started", "A teammate", false],
      ["Agent asked a question", "You", true],
      ["Agent asked a question", "ada-power", false],
      ["Agent is done", "You", true],
    ]);
    expect(cards.find((card) => card.id === "board:m4")?.pullRequestUrl).toBe(
      "https://github.com/acme/app/pull/7",
    );
  });

  it("matches the login when the profile has no name", () => {
    const cards = agentsBoardMomentCards(board(messages), { login: "ADA" });
    expect(cards.filter((card) => card.personal).map((card) => card.id)).toEqual([
      "board:m1",
      "board:m6",
      "board:m8",
    ]);
  });

  it("leaves out the viewer's own cards that repeat this environment's moments", () => {
    const local = {
      branches: singleThreadBranches([
        { branch: "feat/export", lineage: lineage() },
        // A subagent and a side chat on their parent's branch leave it the thread's own.
        { branch: "feat/export", lineage: lineage({ relationshipToParent: "subagent" }) },
        { branch: "feat/export", lineage: lineage({ sideChat: true }) },
        { branch: "main", lineage: lineage() },
        { branch: "main", lineage: lineage() },
        { branch: null, lineage: lineage() },
      ]),
      moments: [moment("local-done", at(17, 10), { kind: "done" })],
    };
    const cards = agentsBoardMomentCards(
      board([
        // On a branch one local thread is on: that thread reporting, so every card goes.
        agentMessage("b1", "ada-1", "started", at(17, 8), "feat/export"),
        agentMessage("b2", "ada-1", "done", at(17, 9), "feat/export"),
        // On a branch no single local thread is on: another machine, or the shared main.
        agentMessage("b3", "ada-7", "done", at(17, 10), "main"),
        // No branch: only a card a local moment of its kind sits next to goes.
        agentMessage("b4", "ada-power-9", "done", at(17, 10), null),
        agentMessage(
          "b5",
          "adalove-4",
          "done",
          new Date(Date.parse(at(17, 10)) + 90_000).toISOString(),
        ),
        agentMessage("b6", "adalove-4", "done", at(17, 13)),
        // A teammate on the same branch is never hidden.
        agentMessage("b7", "sam-2", "done", at(17, 9), "feat/export"),
      ]),
      { login: "ada", name: "Ada" },
      local,
    );
    expect(cards.map((card) => [card.id, card.personal])).toEqual([
      ["board:b3", true],
      ["board:b4", false],
      ["board:b6", true],
      ["board:b7", false],
    ]);
  });

  it("treats every agent as a teammate when no one is signed in", () => {
    const cards = agentsBoardMomentCards(board(messages), null);
    expect(cards).toHaveLength(7);
    expect(cards.some((card) => card.personal)).toBe(false);
  });
});

describe("mergeMomentCards", () => {
  const boardCards = agentsBoardMomentCards(
    board([
      agentMessage("m1", "sam-2", "done", at(17, 10)),
      agentMessage("m0", "sam-2", "done", at(1, 10)),
      agentMessage("m2", "ada-1", "done", at(17, 12)),
    ]),
    { login: "ada" },
  );
  const input = {
    moments: [
      moment("stale", at(1, 9)),
      moment("a", at(17, 9)),
      moment("b", at(17, 11), {
        kind: "pr-testing",
        pullRequest: { number: 4, url: "u", title: null },
      }),
      moment("stable", at(17, 13), { kind: "stable-moved", snippet: "#104, #107, #108" }),
      moment("stable-1", at(17, 14), { kind: "stable-moved", snippet: "#109" }),
    ],
    board: boardCards,
    sinceMillis: Date.parse(at(10, 0)),
  };

  it("orders this project's and teammates' cards together, indenting only personal ones", () => {
    const cards = mergeMomentCards({ ...input, showTeammates: true });
    expect(cards.map((card) => [card.label, card.person])).toEqual([
      ["Thread started", "You"],
      ["Agent is done", "Sam"],
      ["PR #4 is in testing", "You"],
      ["Agent is done", "You"],
      ["Stable moved · 3 PRs", "Project"],
      ["Stable moved · 1 PR", "Project"],
    ]);
  });

  it("hides teammates when the toggle is off, but not the viewer's own board cards", () => {
    const cards = mergeMomentCards({ ...input, showTeammates: false });
    expect(cards.map((card) => card.id)).toEqual(["a", "b", "board:m2", "stable", "stable-1"]);
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
        moment("e", at(18, 11)),
      ],
      board: agentsBoardMomentCards(
        board([
          agentMessage("s", "sam-2", "done", at(18, 8)),
          agentMessage("o", "ada-1", "done", at(18, 10)),
        ]),
        { login: "ada" },
      ),
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
      ["board:o", null],
      ["e", null],
    ]);
  });
});

describe("newestMomentArrival", () => {
  it.each([
    ["the first newest card", null, 100, { arrived: true, newestSeen: 100 }],
    ["a newer card", 100, 200, { arrived: true, newestSeen: 200 }],
    ["the newest card leaving or hidden", 200, 100, { arrived: false, newestSeen: 200 }],
    ["an older card shown again", 200, 200, { arrived: false, newestSeen: 200 }],
    ["an empty stack", 200, null, { arrived: false, newestSeen: 200 }],
  ] as const)("%s", (_name, seen, newest, expected) => {
    expect(newestMomentArrival(seen, newest)).toEqual(expected);
  });
});

describe("resolveMomentCardMaxWidth", () => {
  it("leaves room for the time column, and for the indent of your own cards", () => {
    expect(resolveMomentCardMaxWidth(300, false)).toBe(204);
    expect(resolveMomentCardMaxWidth(300, true)).toBe(192);
    expect(resolveMomentCardMaxWidth(120, true)).toBe(80);
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
