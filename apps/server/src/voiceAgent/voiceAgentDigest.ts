import type {
  AgentsBoardAgent,
  AgentsBoardData,
  AgentsBoardMessage,
  VoiceAgentMediaItem,
} from "@t3tools/contracts";
import { voiceAgentPlainText } from "@t3tools/provider-core/server/runtimeInstructions";

/**
 * What the voice agent is told about the agents board. Every word here was written by other
 * agents, so it is clipped, stripped of the envelope's own tags, and only ever data.
 */

/** Where the last update the agent gave stopped: the messages the board held then. */
export interface VoiceAgentCursor {
  readonly at: string;
  readonly seen: ReadonlyArray<string>;
}

const MAX_DIGEST_MESSAGES = 40;
const MAX_VIEW_MESSAGES = 30;
const MAX_MESSAGE_TEXT = 500;
const MAX_MEDIA_ITEMS = 30;

const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

const plain = (text: string | null, max = MAX_MESSAGE_TEXT) =>
  text === null ? null : clip(voiceAgentPlainText(text).replace(/\s+/g, " "), max) || null;

/** The key of a message the user sent through the voice agent, so the next update leaves it out. */
export const sentMessageKey = (to: string | null, at: string) => `${to ?? "all"}|${at}`;

function describe(
  message: AgentsBoardMessage,
  agents: ReadonlyMap<string, AgentsBoardAgent>,
): string {
  if (message._tag === "person") {
    return [
      `A person, ${plain(message.from, 80) ?? "unnamed"}, wrote to ${message.to ?? "all agents"} at ${message.at}:`,
      plain(message.text) ?? "(no text)",
    ].join("\n");
  }
  const agent = agents.get(message.agentId);
  const who = [
    `agent ${message.agentId}`,
    agent?.owner ? `owner ${plain(agent.owner, 80)}` : null,
    agent?.task ? `task: ${plain(agent.task, 120)}` : null,
  ]
    .filter((part) => part !== null)
    .join(", ");
  return [
    `${who}, at ${message.at}, status ${message.status ?? "not given"}:`,
    plain(message.text) ?? "(no text)",
    ...(message.needs === null ? [] : [`needs from a person: ${plain(message.needs, 200)}`]),
    ...(message.next === null ? [] : [`next: ${plain(message.next, 200)}`]),
    ...(message.media.length === 0 ? [] : [`screenshots: ${message.media.length}`]),
  ].join("\n");
}

/**
 * The board's changes since the cursor, as the text of the layer-opened message, and the cursor
 * to keep once the agent has given that update. `changes` is null when nothing is new.
 */
export function voiceAgentDigest(input: {
  readonly board: AgentsBoardData;
  readonly cursor: VoiceAgentCursor | null;
  readonly now: string;
  /** Messages the user sent through the voice agent: their own words are not news. */
  readonly ownSent: ReadonlySet<string>;
}): { readonly changes: string | null; readonly cursor: VoiceAgentCursor; readonly count: number } {
  const seen = new Set(input.cursor?.seen ?? []);
  const fresh = input.board.messages.filter(
    (message) =>
      !seen.has(message.id) &&
      !(message._tag === "person" && input.ownSent.has(sentMessageKey(message.to, message.at))),
  );
  const cursor = { at: input.now, seen: input.board.messages.map((message) => message.id) };
  if (fresh.length === 0) return { changes: null, cursor, count: 0 };
  const agents = new Map(input.board.agents.map((agent) => [agent.id, agent]));
  const shown = fresh.slice(-MAX_DIGEST_MESSAGES);
  const changes = [
    `<board_changes now="${input.now}" agents_running="${input.board.activeCount}" agents_needing_a_person="${input.board.needsPersonCount}">`,
    ...(shown.length < fresh.length
      ? [`(${fresh.length - shown.length} older changes are left out.)`, ""]
      : []),
    shown.map((message) => describe(message, agents)).join("\n\n"),
    "</board_changes>",
  ].join("\n");
  return { changes, cursor, count: fresh.length };
}

/** What `voice_board` answers: the agents now, and their newest messages. */
export function voiceAgentBoardView(input: {
  readonly board: AgentsBoardData;
  readonly now: string;
  readonly since?: string | undefined;
  readonly agentId?: string | undefined;
}) {
  const wanted = input.agentId?.toLowerCase();
  const sinceMs = input.since === undefined ? Number.NaN : Date.parse(input.since);
  const agents = input.board.agents.filter(
    (agent) => wanted === undefined || agent.id.toLowerCase() === wanted,
  );
  const messages = input.board.messages
    .filter(
      (message) =>
        (wanted === undefined ||
          (message._tag === "agent" ? message.agentId : message.to)?.toLowerCase() === wanted) &&
        (Number.isNaN(sinceMs) || Date.parse(message.at) >= sinceMs),
    )
    .slice(-MAX_VIEW_MESSAGES);
  return {
    now: input.now,
    agentsRunning: input.board.activeCount,
    agentsNeedingAPerson: input.board.needsPersonCount,
    agents: agents.map((agent) => ({
      id: agent.id,
      owner: plain(agent.owner, 80),
      task: plain(agent.task, 120),
      status: agent.latestStatus,
      lastReportAt: agent.latestAt,
      needsFromAPerson: plain(agent.needs, 200),
    })),
    messages: messages.map((message) =>
      message._tag === "agent"
        ? {
            from: `agent ${message.agentId}`,
            at: message.at,
            status: message.status,
            text: plain(message.text) ?? "",
            needsFromAPerson: plain(message.needs, 200),
            screenshots: message.media.length,
          }
        : {
            from: `person ${plain(message.from, 80) ?? "unnamed"}`,
            to: message.to ?? "all agents",
            at: message.at,
            text: plain(message.text) ?? "",
          },
    ),
  };
}
export type VoiceAgentBoardView = ReturnType<typeof voiceAgentBoardView>;

/** The board's screenshots, newest report first, with the report each belongs to. */
export function voiceAgentMediaItems(
  board: AgentsBoardData,
  agentId: string | undefined,
): ReadonlyArray<VoiceAgentMediaItem & { readonly report: string }> {
  const wanted = agentId?.toLowerCase();
  return board.messages
    .toReversed()
    .flatMap((message) =>
      message._tag === "agent" && (wanted === undefined || message.agentId.toLowerCase() === wanted)
        ? message.media.map((path) => ({
            path,
            agentId: message.agentId,
            at: message.at,
            report: plain(message.text, 300) ?? "",
          }))
        : [],
    )
    .slice(0, MAX_MEDIA_ITEMS);
}
