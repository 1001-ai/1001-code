import type { VoiceAgentSession } from "@t3tools/contracts";

/** The timeline row that holds the cards of one or more voice conversations held in one gap. */
export type LampTranscriptRow = {
  kind: "lamp-transcripts";
  id: string;
  createdAt: string;
  threadKey: string;
  sessions: ReadonlyArray<VoiceAgentSession>;
};

const ROW_ID_PREFIX = "lamp-transcripts:";

/**
 * Places each conversation's card right before the first row created after it opened, or at the
 * end. Rows without a time never bound a card; one gap's conversations share a row. A `previous`
 * row with the same conversations is reused; no rows or no conversations return `rows` itself.
 */
export function withLampTranscriptRows<Row extends { readonly createdAt: string | null }>(
  rows: Array<Row>,
  sessions: ReadonlyArray<VoiceAgentSession>,
  threadKey: string,
  previous: ReadonlyMap<string, LampTranscriptRow> = new Map(),
): Array<Row | LampTranscriptRow> {
  if (rows.length === 0 || sessions.length === 0) return rows;
  const ordered = [...sessions].sort((a, b) => Date.parse(a.openedAt) - Date.parse(b.openedAt));
  const result: Array<Row | LampTranscriptRow> = [];
  let rowIndex = 0;
  let sessionIndex = 0;
  while (sessionIndex < ordered.length) {
    const openedAt = Date.parse(ordered[sessionIndex]!.openedAt);
    // Sessions are in time order, so each one's gap is at or after the one before it.
    while (rowIndex < rows.length && !(rowTime(rows[rowIndex]!) > openedAt)) {
      result.push(rows[rowIndex]!);
      rowIndex += 1;
    }
    const next = rowIndex < rows.length ? rowTime(rows[rowIndex]!) : Number.POSITIVE_INFINITY;
    const gap: VoiceAgentSession[] = [];
    while (sessionIndex < ordered.length && next > Date.parse(ordered[sessionIndex]!.openedAt)) {
      gap.push(ordered[sessionIndex]!);
      sessionIndex += 1;
    }
    result.push(lampTranscriptRow(gap, threadKey, previous));
  }
  for (; rowIndex < rows.length; rowIndex += 1) result.push(rows[rowIndex]!);
  return result;
}

function rowTime(row: { readonly createdAt: string | null }): number {
  return row.createdAt === null ? Number.NaN : Date.parse(row.createdAt);
}

function lampTranscriptRow(
  sessions: ReadonlyArray<VoiceAgentSession>,
  threadKey: string,
  previous: ReadonlyMap<string, LampTranscriptRow>,
): LampTranscriptRow {
  const id = `${ROW_ID_PREFIX}${sessions[0]!.id}`;
  const reused = previous.get(id);
  if (
    reused &&
    reused.threadKey === threadKey &&
    reused.sessions.length === sessions.length &&
    reused.sessions.every((session, index) => session.id === sessions[index]!.id)
  ) {
    return reused;
  }
  return { kind: "lamp-transcripts", id, createdAt: sessions[0]!.openedAt, threadKey, sessions };
}

/** A card's second line: when the conversation was, and how long. */
export function lampTranscriptSummary(
  session: Pick<VoiceAgentSession, "openedAt" | "turns">,
  formatTime: (at: string) => string,
): string {
  return `${formatTime(session.openedAt)} · ${session.turns} ${session.turns === 1 ? "turn" : "turns"}`;
}
