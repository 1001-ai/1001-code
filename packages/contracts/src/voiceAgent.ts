import * as Schema from "effect/Schema";

import { AgentsBoardAgentId, AgentsBoardMediaPath } from "./agentsBoard.ts";
import { IsoDateTime, NonNegativeInt, ProjectId, ThreadId } from "./baseSchemas.ts";
import { MEMORY_PROPOSE_TOOL_NAME } from "./memory.ts";

/**
 * The voice agent speaks in the glass layer over a chat: it reports what the agents on the
 * project's agents board did, answers the user, and can message those agents. It runs as a hidden
 * thread under the chat it was opened over, so its messages are the transcript.
 */

/** The one place that names the model. Haiku, for speed: the user waits to hear the answer. */
export const VOICE_AGENT_DEFAULT_MODEL = "claude-haiku-5-5";
export const VOICE_AGENT_THREAD_TITLE = "Voice agent";
/** What is said when nothing changed since the last update: by the layer itself, with no turn. */
export const VOICE_AGENT_NOTHING_NEW_LINE = "Nothing new to report. What do you want to build?";

export const VOICE_AGENT_BOARD_TOOL_NAME = "voice_board";
export const VOICE_AGENT_SEND_MESSAGE_TOOL_NAME = "voice_send_message";
export const VOICE_AGENT_SHOW_MEDIA_TOOL_NAME = "voice_show_media";

/** Every tool a voice agent thread may list or call. Nothing else reaches it. */
export const VOICE_AGENT_TOOL_NAMES: ReadonlyArray<string> = [
  VOICE_AGENT_BOARD_TOOL_NAME,
  VOICE_AGENT_SEND_MESSAGE_TOOL_NAME,
  VOICE_AGENT_SHOW_MEDIA_TOOL_NAME,
  MEMORY_PROPOSE_TOOL_NAME,
];

/** The tools only a voice agent thread may list or call. */
export const VOICE_AGENT_ONLY_TOOL_NAMES: ReadonlyArray<string> = [
  VOICE_AGENT_BOARD_TOOL_NAME,
  VOICE_AGENT_SEND_MESSAGE_TOOL_NAME,
  VOICE_AGENT_SHOW_MEDIA_TOOL_NAME,
];

/**
 * Whether a caller may list or call a tool of T3's MCP server: a voice agent thread only its own
 * tools, and every other caller everything but those.
 */
export function voiceAgentToolAllowed(tool: string, callerIsVoiceAgent: boolean): boolean {
  return callerIsVoiceAgent
    ? VOICE_AGENT_TOOL_NAMES.includes(tool)
    : !VOICE_AGENT_ONLY_TOOL_NAMES.includes(tool);
}

/** A message to another agent is signed as a person and pushed to a shared branch: keep it short. */
export const VOICE_AGENT_INBOX_MESSAGE_MAX_LENGTH = 600;
/** What the user said in one go, as the transcript the agent gets. */
export const VOICE_AGENT_SAID_MAX_LENGTH = 4_000;
const SPOKEN_CONTEXT_MAX_LENGTH = 8_000;

export const VoiceAgentSessionId = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/),
);
export type VoiceAgentSessionId = typeof VoiceAgentSessionId.Type;

/** The chat the layer was opened over. */
export const VoiceAgentThreadInput = Schema.Struct({
  threadId: ThreadId,
  /**
   * The project of a new chat that has no thread on the server yet. Only `open` reads it, and
   * only when the thread does not exist: the conversation is kept under the id the chat gets.
   */
  projectId: Schema.optional(ProjectId),
});
export type VoiceAgentThreadInput = typeof VoiceAgentThreadInput.Type;

export const VoiceAgentOpenResult = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("ready"),
    sessionId: VoiceAgentSessionId,
    /** The hidden thread whose messages are the conversation. */
    voiceThreadId: ThreadId,
    /** Messages of that thread from this time on belong to this session. */
    openedAt: IsoDateTime,
    /** `requested`: the agent is asked for the update. `nothing-new`: no turn was started. */
    update: Schema.Literals(["requested", "nothing-new"]),
  }),
  /** No agent can answer, and the one line that says why. */
  Schema.Struct({ status: Schema.Literal("unavailable"), message: Schema.String }),
]);
export type VoiceAgentOpenResult = typeof VoiceAgentOpenResult.Type;

/** Where the user cut the agent off: what it had said aloud, and what it had not yet said. */
export const VoiceAgentInterruption = Schema.Struct({
  spoken: Schema.String.check(Schema.isMaxLength(SPOKEN_CONTEXT_MAX_LENGTH)),
  unspoken: Schema.String.check(Schema.isMaxLength(SPOKEN_CONTEXT_MAX_LENGTH)),
});
export type VoiceAgentInterruption = typeof VoiceAgentInterruption.Type;

export const VoiceAgentSayInput = Schema.Struct({
  sessionId: VoiceAgentSessionId,
  text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(VOICE_AGENT_SAID_MAX_LENGTH)),
  interruption: Schema.optional(VoiceAgentInterruption),
});
export type VoiceAgentSayInput = typeof VoiceAgentSayInput.Type;

export const VoiceAgentSayResult = Schema.Struct({
  /** `steered` when the agent was still answering: it is nudged, not restarted. */
  delivery: Schema.Literals(["started", "queued", "steered", "restarted"]),
});
export type VoiceAgentSayResult = typeof VoiceAgentSayResult.Type;

export const VoiceAgentSessionInput = Schema.Struct({ sessionId: VoiceAgentSessionId });
export type VoiceAgentSessionInput = typeof VoiceAgentSessionInput.Type;

/** A closed voice conversation in which something was said. */
export const VoiceAgentSession = Schema.Struct({
  id: VoiceAgentSessionId,
  openedAt: IsoDateTime,
  closedAt: IsoDateTime,
  turns: NonNegativeInt,
});
export type VoiceAgentSession = typeof VoiceAgentSession.Type;

export const VoiceAgentMediaItem = Schema.Struct({
  path: AgentsBoardMediaPath,
  agentId: AgentsBoardAgentId,
  at: IsoDateTime,
});
export type VoiceAgentMediaItem = typeof VoiceAgentMediaItem.Type;

/** The screenshots in front of the user, one at a time. */
export const VoiceAgentMedia = Schema.Struct({
  sessionId: VoiceAgentSessionId,
  items: Schema.Array(VoiceAgentMediaItem),
  index: NonNegativeInt,
});
export type VoiceAgentMedia = typeof VoiceAgentMedia.Type;

/** What a chat shows of its voice agent: its closed conversations, oldest first, and the player. */
export const VoiceAgentState = Schema.Struct({
  sessions: Schema.Array(VoiceAgentSession),
  media: Schema.NullOr(VoiceAgentMedia),
});
export type VoiceAgentState = typeof VoiceAgentState.Type;

export const VoiceAgentMediaStepInput = Schema.Struct({
  sessionId: VoiceAgentSessionId,
  /** The screenshot to show; null puts them away. */
  index: Schema.NullOr(NonNegativeInt),
});
export type VoiceAgentMediaStepInput = typeof VoiceAgentMediaStepInput.Type;

export const VoiceAgentTurn = Schema.Struct({
  role: Schema.Literals(["user", "agent"]),
  text: Schema.String,
  at: IsoDateTime,
});
export type VoiceAgentTurn = typeof VoiceAgentTurn.Type;

export const VoiceAgentTranscript = Schema.Struct({
  sessionId: VoiceAgentSessionId,
  openedAt: IsoDateTime,
  closedAt: Schema.NullOr(IsoDateTime),
  turns: Schema.Array(VoiceAgentTurn),
});
export type VoiceAgentTranscript = typeof VoiceAgentTranscript.Type;

export const VoiceAgentErrorReason = Schema.Literals([
  "thread-not-found",
  "session-not-found",
  "session-closed",
  "not-delivered",
]);
export type VoiceAgentErrorReason = typeof VoiceAgentErrorReason.Type;

const ERROR_MESSAGES: Record<VoiceAgentErrorReason, string> = {
  "thread-not-found": "This chat no longer exists, so the voice agent has nothing to open over.",
  "session-not-found": "This voice conversation no longer exists.",
  "session-closed": "This voice conversation has ended.",
  "not-delivered":
    "The server could not start the voice agent's answer. Check that Claude answers in a chat, then open this again.",
};

/** What the layer says when the server did not answer at all. */
const VOICE_AGENT_NO_ANSWER_MESSAGE =
  "The server did not answer. Check the connection to this environment, then open the voice agent again.";

const isErrorReason = Schema.is(VoiceAgentErrorReason);

/**
 * The one line the layer shows when a conversation could not be opened: the server's own reason
 * when it gave one, that this connection may not use the agent, and otherwise that the server
 * did not answer.
 */
export function voiceAgentOpenFailureMessage(error: unknown): string {
  const fields = typeof error === "object" && error !== null ? error : {};
  const reason = "reason" in fields ? fields.reason : undefined;
  if (isErrorReason(reason)) return ERROR_MESSAGES[reason];
  return "_tag" in fields && fields._tag === "EnvironmentAuthorizationError"
    ? "This connection is not allowed to use the voice agent on this server."
    : VOICE_AGENT_NO_ANSWER_MESSAGE;
}

/**
 * The voice agent's thread is never one of the client's threads: no list, chip, pane or count
 * may show it. It is read only by id, by the layer and the transcript. Returns the same array
 * when it holds none, so nothing recomputes.
 */
export function withoutVoiceAgentThreads<
  Thread extends { readonly lineage: { readonly voiceAgent?: boolean | undefined } },
>(threads: ReadonlyArray<Thread>): ReadonlyArray<Thread> {
  return threads.some((thread) => thread.lineage.voiceAgent === true)
    ? threads.filter((thread) => thread.lineage.voiceAgent !== true)
    : threads;
}

export class VoiceAgentError extends Schema.TaggedError<VoiceAgentError>()("VoiceAgentError", {
  reason: VoiceAgentErrorReason,
}) {
  override get message(): string {
    return ERROR_MESSAGES[this.reason];
  }
}
