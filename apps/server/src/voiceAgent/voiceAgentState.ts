import type {
  OrchestrationV2ConversationMessage,
  VoiceAgentSession,
  VoiceAgentTurn,
} from "@t3tools/contracts";
import { parseVoiceAgentUserMessage } from "@t3tools/provider-core/server/runtimeInstructions";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

/**
 * What the voice agent keeps between server runs, in its own file: the database's migrations
 * are upstream's. The conversation itself is the hidden thread's messages; this holds which
 * thread serves which chat, where each conversation starts and ends, and the update cursor.
 */
const Cursor = Schema.Struct({ at: Schema.String, seen: Schema.Array(Schema.String) });

const StoredSession = Schema.Struct({
  id: Schema.String,
  parentThreadId: Schema.String,
  voiceThreadId: Schema.String,
  openedAt: Schema.String,
  closedAt: Schema.NullOr(Schema.String),
  turns: Schema.Number,
  /** How often the user has spoken in it. */
  said: Schema.Number,
  /** The user's name as the agents board signs it, read once when the conversation opened. */
  userName: Schema.optional(Schema.NullOr(Schema.String)),
  /** The cursor to keep once the agent has given this conversation's update. */
  pendingCursor: Schema.optional(Schema.Struct({ key: Schema.String, cursor: Cursor })),
});
export type StoredVoiceAgentSession = typeof StoredSession.Type;

export const VoiceAgentStateFile = Schema.Struct({
  /** The voice agent's thread, by the chat it was opened over. */
  threads: Schema.Record(Schema.String, Schema.String),
  /** The update cursor, by the team project's key. */
  cursors: Schema.Record(Schema.String, Cursor),
  sessions: Schema.Array(StoredSession),
  /** Messages the user sent through the agent, as `sentMessageKey`. */
  sent: Schema.Array(Schema.String),
});
export type VoiceAgentStateFile = typeof VoiceAgentStateFile.Type;

export const EMPTY_VOICE_AGENT_STATE: VoiceAgentStateFile = {
  threads: {},
  cursors: {},
  sessions: [],
  sent: [],
};

export const MAX_STORED_SESSIONS = 200;
export const MAX_STORED_SENT = 100;

/**
 * The conversations a chat shows as cards: only closed ones, and only those in which something
 * was said. An open conversation never shows, so the card appears when the layer closes.
 */
export function closedVoiceAgentSessions(
  state: VoiceAgentStateFile,
  parentThreadId: string,
): ReadonlyArray<VoiceAgentSession> {
  return state.sessions.flatMap((session) =>
    session.parentThreadId === parentThreadId && session.closedAt !== null && session.turns > 0
      ? [
          {
            id: session.id,
            openedAt: session.openedAt,
            closedAt: session.closedAt,
            turns: session.turns,
          },
        ]
      : [],
  );
}

/**
 * The turns of one conversation, from the hidden thread's messages between its opening and its
 * close. The layer-opened message is the server's, not something the user said, and an agent's
 * consecutive messages (around a tool call) are one turn.
 */
export function voiceAgentTurns(
  messages: ReadonlyArray<Pick<OrchestrationV2ConversationMessage, "role" | "text" | "createdAt">>,
  window: { readonly openedAt: string; readonly closedAt: string | null },
): ReadonlyArray<VoiceAgentTurn> {
  const from = Date.parse(window.openedAt);
  const to = window.closedAt === null ? Number.POSITIVE_INFINITY : Date.parse(window.closedAt);
  const turns: Array<VoiceAgentTurn> = [];
  for (const message of messages) {
    const at = DateTime.toEpochMillis(message.createdAt);
    if (at < from || at > to) continue;
    const text =
      message.role === "assistant"
        ? message.text.trim()
        : message.role === "user"
          ? (() => {
              const parsed = parseVoiceAgentUserMessage(message.text);
              return parsed.kind === "said" ? parsed.text : "";
            })()
          : "";
    if (text === "") continue;
    const role = message.role === "assistant" ? "agent" : "user";
    const last = turns.at(-1);
    if (role === "agent" && last?.role === "agent") {
      turns[turns.length - 1] = { ...last, text: `${last.text}\n\n${text}` };
    } else {
      turns.push({ role, text, at: DateTime.formatIso(message.createdAt) });
    }
  }
  return turns;
}
