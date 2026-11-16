import type { VoiceAgentSession } from "@t3tools/contracts";

/** How many of a chat's voice conversations show before "Show earlier". */
const SHOWN_AT_FIRST = 3;

/**
 * The cards the end of a chat shows: its newest closed voice conversations, oldest first, and
 * how many earlier ones wait behind "Show earlier".
 */
export function lampTranscriptCards(
  sessions: ReadonlyArray<VoiceAgentSession>,
  showAll: boolean,
): { readonly shown: ReadonlyArray<VoiceAgentSession>; readonly earlier: number } {
  const shown = showAll ? sessions : sessions.slice(-SHOWN_AT_FIRST);
  return { shown, earlier: sessions.length - shown.length };
}

/** A card's second line: when the conversation was, and how long. */
export function lampTranscriptSummary(
  session: Pick<VoiceAgentSession, "openedAt" | "turns">,
  formatTime: (at: string) => string,
): string {
  return `${formatTime(session.openedAt)} · ${session.turns} ${session.turns === 1 ? "turn" : "turns"}`;
}
