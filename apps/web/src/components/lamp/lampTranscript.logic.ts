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

/** Row flags that join a row to its neighbour; a card between two rows parts them. */
type Adjacency = {
  readonly continuesWorkLog?: boolean;
  readonly groupedWithNext?: boolean;
  readonly groupedWithPrevious?: boolean;
  readonly continuesSteer?: boolean;
};

/**
 * Places each conversation's card right before the first row created after it opened, or at the
 * end, parting the rows around it. Rows without a time never bound a card; one gap's conversations
 * share a row. A `previous` card row with the same conversations is reused.
 */
export function withLampTranscriptRows<
  Row extends { readonly createdAt: string | null } & Adjacency,
>(
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
  return result.map((row, index) => {
    if (isCard(row)) return row;
    return partedRow(row, isCard(result[index - 1]), isCard(result[index + 1]));
  });
}

function isCard(row: { readonly createdAt: string | null } | undefined): row is LampTranscriptRow {
  return row !== undefined && "kind" in row && row.kind === "lamp-transcripts";
}

function partedRow<Row extends Adjacency>(row: Row, cardBefore: boolean, cardAfter: boolean): Row {
  const joinsNext = cardAfter && (row.continuesWorkLog === true || row.groupedWithNext === true);
  const joinsPrevious =
    cardBefore && (row.groupedWithPrevious === true || row.continuesSteer === true);
  if (!joinsNext && !joinsPrevious) return row;
  return {
    ...row,
    ...(joinsNext ? { continuesWorkLog: false, groupedWithNext: false } : {}),
    ...(joinsPrevious ? { groupedWithPrevious: false, continuesSteer: false } : {}),
  };
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
