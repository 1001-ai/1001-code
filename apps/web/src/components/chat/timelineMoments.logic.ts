import {
  type AgentsBoardData,
  PROJECT_MOMENTS_LIMIT,
  type ProjectMoment,
  type ProjectMomentsStreamItem,
  type ThreadId,
} from "@t3tools/contracts";

import type { MessagesTimelineRow } from "./MessagesTimeline.logic";

export interface ProjectMomentsState {
  readonly moments: ReadonlyArray<ProjectMoment>;
  readonly truncated: boolean;
}

export const EMPTY_PROJECT_MOMENTS: ProjectMomentsState = { moments: [], truncated: false };

function compareByTime(left: { at: string; id: string }, right: { at: string; id: string }) {
  const byTime = Date.parse(left.at) - Date.parse(right.at);
  if (byTime !== 0 && Number.isFinite(byTime)) return byTime;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

/** Folds one stream item into the project's moments, oldest first. */
export function applyProjectMomentsItem(
  state: ProjectMomentsState,
  item: ProjectMomentsStreamItem,
): ProjectMomentsState {
  switch (item.kind) {
    case "snapshot":
      return { moments: item.moments, truncated: item.truncated };
    case "upsert":
      return {
        ...state,
        // A long-lived subscription keeps adding; keep the newest a snapshot would hold.
        moments: [...state.moments.filter((moment) => moment.id !== item.moment.id), item.moment]
          .toSorted(compareByTime)
          .slice(-PROJECT_MOMENTS_LIMIT),
      };
    case "remove":
      return { ...state, moments: state.moments.filter((moment) => moment.id !== item.id) };
    case "remove-thread":
      return {
        ...state,
        moments: state.moments.filter((moment) => moment.threadId !== item.threadId),
      };
  }
}

/** Picks the card's icon and its colour. */
export type MomentTone = "ask" | "prompt" | "agent" | "done" | "testing" | "merged" | "started";

export interface MomentCard {
  readonly id: string;
  readonly at: string;
  readonly label: string;
  readonly detail: string;
  readonly tone: MomentTone;
  /** From this environment's own threads; teammates' cards come from the agents board. */
  readonly personal: boolean;
  /** Whose card it is, shown above each run of one person's cards: "You" or the teammate. */
  readonly person: string;
  readonly threadId: ThreadId | null;
  readonly threadTitle: string | null;
  readonly messageId: string | null;
  readonly pullRequestUrl: string | null;
}

function momentLabel(moment: ProjectMoment): string {
  switch (moment.kind) {
    case "question":
    case "input-request":
      return "Agent asked a question";
    case "thread-started":
      return "Thread started";
    case "agent-out":
      return `Your agent messaged ${moment.sender?.title ?? "another machine"}`;
    case "agent-in":
      return `${moment.sender?.title ?? "Another agent"} messaged your agent`;
    case "done":
      return "Implementation done";
    case "pr-testing":
      return `PR #${moment.pullRequest?.number ?? "?"} is in testing`;
    case "pr-merged":
      return `PR #${moment.pullRequest?.number ?? "?"} merged`;
  }
}

const TONE_BY_KIND: Record<ProjectMoment["kind"], MomentTone> = {
  question: "ask",
  "input-request": "ask",
  "thread-started": "prompt",
  "agent-in": "agent",
  "agent-out": "agent",
  done: "done",
  "pr-testing": "testing",
  "pr-merged": "merged",
};

function projectMomentCard(moment: ProjectMoment): MomentCard {
  return {
    id: moment.id,
    at: moment.at,
    label: momentLabel(moment),
    detail: moment.snippet,
    tone: TONE_BY_KIND[moment.kind],
    personal: true,
    person: "You",
    threadId: moment.threadId,
    threadTitle: moment.threadTitle,
    messageId: moment.messageId,
    pullRequestUrl: moment.pullRequest?.url ?? null,
  };
}

/** An agent id is `<owner>-<number>`, so the viewer's own agents match either way. */
function isViewersBoardAgent(
  agentId: string,
  owner: string | null,
  viewerLogin: string | null,
): boolean {
  if (viewerLogin === null || viewerLogin.length === 0) return false;
  const login = viewerLogin.toLowerCase();
  const id = agentId.toLowerCase();
  // The id prefix is only a fallback: `ada-power-9` belongs to ada-power, not ada.
  if (owner !== null) return owner.toLowerCase() === login;
  return id === login || id.startsWith(`${login}-`);
}

const PR_URL = /^https?:\/\/\S+$/;

/**
 * Teammates' agents from the agents board: questions and blocks, finished work and starts.
 * Working updates and the viewer's own agents (already shown from this environment) are left out.
 */
export function teammateMomentCards(
  board: AgentsBoardData | null,
  viewerLogin: string | null,
): ReadonlyArray<MomentCard> {
  if (board === null) return [];
  const owners = new Map(board.agents.map((agent) => [agent.id, agent.owner]));
  const cards: MomentCard[] = [];
  for (const message of board.messages) {
    if (message._tag !== "agent") continue;
    const owner = owners.get(message.agentId) ?? null;
    if (isViewersBoardAgent(message.agentId, owner, viewerLogin)) continue;
    const base = {
      id: `board:${message.id}`,
      at: message.at,
      detail: message.text,
      personal: false,
      person: owner ?? "A teammate",
      threadId: null,
      threadTitle: message.agentId,
      messageId: null,
    };
    switch (message.status) {
      case "question":
      case "blocked":
        cards.push({
          ...base,
          label: "Agent asked a question",
          tone: "ask",
          pullRequestUrl: null,
        });
        break;
      case "done":
        cards.push({
          ...base,
          label: "Agent is done",
          tone: "done",
          pullRequestUrl: message.pr !== null && PR_URL.test(message.pr) ? message.pr : null,
        });
        break;
      case "started":
        cards.push({
          ...base,
          label: "Agent started",
          tone: "started",
          pullRequestUrl: null,
        });
        break;
      default:
        break;
    }
  }
  return cards;
}

/** This project's moments and teammates' cards in one list, oldest first. */
export function mergeMomentCards(input: {
  readonly moments: ReadonlyArray<ProjectMoment>;
  readonly teammates: ReadonlyArray<MomentCard>;
  readonly showTeammates: boolean;
  readonly sinceMillis: number;
}): ReadonlyArray<MomentCard> {
  const recent = (card: MomentCard) => Date.parse(card.at) >= input.sinceMillis;
  const teammates = input.showTeammates ? input.teammates.filter(recent) : [];
  return [...input.moments.map(projectMomentCard).filter(recent), ...teammates].toSorted(
    compareByTime,
  );
}

export type MomentStackEntry =
  | { readonly kind: "day"; readonly id: string; readonly label: string }
  | {
      readonly kind: "card";
      readonly card: MomentCard;
      /** The person's name on the first card of their run within a day; null on the rest. */
      readonly groupName: string | null;
    };

function localDayStart(millis: number): number {
  const date = new Date(millis);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function dayLabel(millis: number, nowMillis: number): string {
  const day = localDayStart(millis);
  const today = localDayStart(nowMillis);
  if (day === today) return "Today";
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  if (day === yesterday.getTime()) return "Yesterday";
  return new Date(millis).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

/**
 * Cards with a separator before the first card of each local day, each run of one person's
 * cards named on its first card. A new day starts a new run.
 */
export function momentStackEntries(
  cards: ReadonlyArray<MomentCard>,
  nowMillis: number,
): ReadonlyArray<MomentStackEntry> {
  const entries: MomentStackEntry[] = [];
  let currentDay: number | null = null;
  let currentPerson: string | null = null;
  for (const card of cards) {
    const millis = Date.parse(card.at);
    const day = localDayStart(millis);
    if (day !== currentDay) {
      currentDay = day;
      currentPerson = null;
      entries.push({ kind: "day", id: `day:${day}`, label: dayLabel(millis, nowMillis) });
    }
    const person = `${card.personal}:${card.person}`;
    entries.push({ kind: "card", card, groupName: person === currentPerson ? null : card.person });
    currentPerson = person;
  }
  return entries;
}

const MOMENT_CARDS_MIN_GUTTER = 200;
const MOMENT_CARDS_HYSTERESIS = 8;

/** Cards need a wide side gutter; the band below the threshold stops a resize from flickering. */
export function resolveMomentCardsVisible(sideGutter: number, visible: boolean): boolean {
  return visible
    ? sideGutter >= MOMENT_CARDS_MIN_GUTTER - MOMENT_CARDS_HYSTERESIS
    : sideGutter >= MOMENT_CARDS_MIN_GUTTER;
}

// The stack's side padding, the time column and the gap after it.
const MOMENT_CARD_CHROME = 88;
const MOMENT_CARD_MAX_WIDTH = 300;

export function resolveMomentCardMaxWidth(sideGutter: number): number {
  return Math.max(80, Math.min(MOMENT_CARD_MAX_WIDTH, Math.floor(sideGutter) - MOMENT_CARD_CHROME));
}

/** The loaded timeline row that shows a message, keyed the way the minimap keys its strips. */
export function findMessageRow(
  rows: ReadonlyArray<MessagesTimelineRow>,
  messageId: string,
): { readonly rowId: string; readonly rowIndex: number } | null {
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (row?.kind === "message" && row.message.id === messageId) {
      return { rowId: row.id, rowIndex: index };
    }
  }
  return null;
}
