import {
  type AgentsBoardData,
  type AgentsBoardStatus,
  isListedThreadLineage,
  type OrchestrationV2AppThreadLineage,
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
export type MomentTone =
  | "ask"
  | "prompt"
  | "agent"
  | "done"
  | "testing"
  | "merged"
  | "started"
  | "release";

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
    case "stable-moved": {
      const count = moment.snippet.match(/#\d+/g)?.length ?? 0;
      return count === 0 ? "Stable moved" : `Stable moved · ${count} ${count === 1 ? "PR" : "PRs"}`;
    }
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
  "stable-moved": "release",
};

function projectMomentCard(moment: ProjectMoment): MomentCard {
  return {
    id: moment.id,
    at: moment.at,
    label: momentLabel(moment),
    detail: moment.snippet,
    tone: TONE_BY_KIND[moment.kind],
    personal: true,
    // Nobody's agent moved it: the project's own news.
    person: moment.kind === "stable-moved" ? "Project" : "You",
    threadId: moment.threadId,
    threadTitle: moment.threadTitle,
    messageId: moment.messageId,
    pullRequestUrl: moment.pullRequest?.url ?? null,
  };
}

/**
 * Whether a board agent is the viewer's. Agents write their person's name as `owner`, which is
 * neither the GitHub login nor always one word, so it matches the login or the name the board
 * signs the viewer's messages with, whole or by its first word. An agent id is `<owner>-<number>`.
 */
function isViewersBoardAgent(
  agentId: string,
  owner: string | null,
  viewer: AgentsBoardViewer | null,
): boolean {
  const names = [viewer?.login, viewer?.name]
    .filter((name): name is string => typeof name === "string" && name.length > 0)
    .map((name) => name.toLowerCase());
  if (names.length === 0) return false;
  // The id prefix is only a fallback: `ada-power-9` belongs to ada-power, not ada.
  if (owner !== null) {
    const whole = owner.trim().toLowerCase();
    const first = whole.split(/\s+/)[0] ?? whole;
    return names.includes(whole) || names.includes(first);
  }
  const id = agentId.toLowerCase();
  return names.some((name) => id === name || id.startsWith(`${name}-`));
}

const PR_URL = /^https?:\/\/\S+$/;
const BOARD_TONES: Record<AgentsBoardStatus, MomentTone | null> = {
  question: "ask",
  blocked: "ask",
  done: "done",
  started: "started",
  working: null,
};

/** Who is looking: the team catalog's viewer, by GitHub login and board name. */
export interface AgentsBoardViewer {
  readonly login: string | null;
  readonly name?: string;
}

/**
 * The branches exactly one of this environment's listed threads in the project is on. A branch
 * several threads share, such as the default branch, says nothing about which thread an agent is;
 * subagents, side chats and the voice agent run on their parent's branch, so they do not count.
 */
export function singleThreadBranches(
  threads: ReadonlyArray<{
    readonly branch: string | null;
    readonly lineage: OrchestrationV2AppThreadLineage;
  }>,
): ReadonlySet<string> {
  const counts = new Map<string, number>();
  for (const { branch, lineage } of threads) {
    if (branch === null || !isListedThreadLineage(lineage) || lineage.voiceAgent === true) continue;
    counts.set(branch, (counts.get(branch) ?? 0) + 1);
  }
  return new Set([...counts].filter(([, count]) => count === 1).map(([branch]) => branch));
}

/** What this environment already shows, so the viewer's local agents are not shown twice. */
export interface LocalMoments {
  readonly branches: ReadonlySet<string>;
  readonly moments: ReadonlyArray<ProjectMoment>;
}

// A board card with no branch to go by duplicates a local moment of its kind this close to it.
const DUPLICATE_WINDOW_MILLIS = 2 * 60 * 1000;
const LOCAL_KINDS_BY_TONE: Partial<Record<MomentTone, ReadonlyArray<ProjectMoment["kind"]>>> = {
  done: ["done"],
  ask: ["question", "input-request"],
  started: ["thread-started"],
};

function duplicatesLocalMoment(
  tone: MomentTone,
  at: string,
  moments: ReadonlyArray<ProjectMoment>,
): boolean {
  const kinds = LOCAL_KINDS_BY_TONE[tone] ?? [];
  const millis = Date.parse(at);
  return moments.some(
    (moment) =>
      kinds.includes(moment.kind) &&
      Math.abs(Date.parse(moment.at) - millis) <= DUPLICATE_WINDOW_MILLIS,
  );
}

/**
 * Agents board cards (questions, blocks, finished work, starts). The viewer's own are "You" cards,
 * minus repeats of local moments: an agent on a single local thread's branch loses every card, one
 * that names no branch loses each card a local moment of its kind is within two minutes of.
 */
export function agentsBoardMomentCards(
  board: AgentsBoardData | null,
  viewer: AgentsBoardViewer | null,
  local: LocalMoments = { branches: new Set(), moments: [] },
): ReadonlyArray<MomentCard> {
  if (board === null) return [];
  const owners = new Map(board.agents.map((agent) => [agent.id, agent.owner]));
  const branches = new Map<string, Set<string>>();
  for (const message of board.messages) {
    if (message._tag !== "agent" || message.branch === null) continue;
    const named = branches.get(message.agentId) ?? new Set<string>();
    named.add(message.branch.trim());
    branches.set(message.agentId, named);
  }
  const cards: MomentCard[] = [];
  for (const message of board.messages) {
    if (message._tag !== "agent") continue;
    const owner = owners.get(message.agentId) ?? null;
    const mine = isViewersBoardAgent(message.agentId, owner, viewer);
    if (mine) {
      const named = branches.get(message.agentId);
      if (named !== undefined && [...named].some((branch) => local.branches.has(branch))) continue;
      const tone = BOARD_TONES[message.status ?? "working"];
      if (
        named === undefined &&
        tone !== null &&
        duplicatesLocalMoment(tone, message.at, local.moments)
      ) {
        continue;
      }
    }
    const base = {
      id: `board:${message.id}`,
      at: message.at,
      detail: message.text,
      personal: mine,
      person: mine ? "You" : (owner ?? "A teammate"),
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

/** This project's moments and the agents board's cards in one list, oldest first. */
export function mergeMomentCards(input: {
  readonly moments: ReadonlyArray<ProjectMoment>;
  readonly board: ReadonlyArray<MomentCard>;
  /** The Teammates switch: the viewer's own board cards show either way. */
  readonly showTeammates: boolean;
  readonly sinceMillis: number;
}): ReadonlyArray<MomentCard> {
  const recent = (card: MomentCard) => Date.parse(card.at) >= input.sinceMillis;
  const board = input.board.filter(
    (card) => recent(card) && (card.personal || input.showTeammates),
  );
  return [...input.moments.map(projectMomentCard).filter(recent), ...board].toSorted(compareByTime);
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

/**
 * Whether the stack's newest card is newer than any it showed before. A newest card that leaves,
 * or the Teammates switch hiding and showing cards, changes the newest without anything arriving.
 */
export function newestMomentArrival(
  newestSeen: number | null,
  newest: number | null,
): { readonly arrived: boolean; readonly newestSeen: number | null } {
  if (newest === null) return { arrived: false, newestSeen };
  if (newestSeen !== null && newest <= newestSeen) return { arrived: false, newestSeen };
  return { arrived: true, newestSeen: newest };
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
const MOMENT_CARD_CHROME = 96;
const MOMENT_CARD_MAX_WIDTH = 300;

// Your own cards sit this much further right than teammates' (`ms-3`).
const PERSONAL_CARD_INDENT = 12;

export function resolveMomentCardMaxWidth(sideGutter: number, personal: boolean): number {
  const room = Math.floor(sideGutter) - MOMENT_CARD_CHROME - (personal ? PERSONAL_CARD_INDENT : 0);
  return Math.max(80, Math.min(MOMENT_CARD_MAX_WIDTH, room));
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
