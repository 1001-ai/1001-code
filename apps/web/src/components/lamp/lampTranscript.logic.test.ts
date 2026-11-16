import type { VoiceAgentSession } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { lampTranscriptSummary, withLampTranscriptRows } from "./lampTranscript.logic";

const session = (id: string, openedAt: string, turns = 2): VoiceAgentSession => ({
  id: id as VoiceAgentSession["id"],
  openedAt: `2026-11-16T${openedAt}:00.000Z`,
  closedAt: `2026-11-16T${openedAt}:30.000Z`,
  turns,
});
const row = (id: string, at: string | null) => ({
  id,
  createdAt: at === null ? null : `2026-11-16T${at}:00.000Z`,
});
/** The merged rows as ids, with each card row as `[session ids]`. */
const layout = (rows: ReadonlyArray<{ readonly id: string }>) =>
  rows.map((entry) =>
    "sessions" in entry
      ? `[${(entry.sessions as ReadonlyArray<VoiceAgentSession>).map((s) => s.id).join(",")}]`
      : entry.id,
  );

describe("withLampTranscriptRows", () => {
  const rows = [row("u1", "10:00"), row("a1", "10:01"), row("u2", "11:00"), row("a2", "11:05")];

  it("puts each conversation between the rows made before and after it opened", () => {
    expect(
      layout(
        withLampTranscriptRows(
          rows,
          [session("late", "12:00"), session("early", "09:00"), session("mid", "10:30")],
          "t",
        ),
      ),
    ).toEqual(["[early]", "u1", "a1", "[mid]", "u2", "a2", "[late]"]);
  });

  it("shares one row between conversations in the same gap and skips rows without a time", () => {
    const merged = withLampTranscriptRows(
      [row("setup", null), ...rows],
      [session("b", "10:40"), session("a", "10:30"), session("c", "11:00")],
      "t",
    );
    // A row made at the moment a conversation opened counts as made before it.
    expect(layout(merged)).toEqual(["setup", "u1", "a1", "[a,b]", "u2", "[c]", "a2"]);
    expect(merged[3]).toMatchObject({
      id: "lamp-transcripts:a",
      createdAt: "2026-11-16T10:30:00.000Z",
    });
    expect(
      layout(withLampTranscriptRows([row("setup", null), ...rows], [session("x", "08:00")], "t")),
    ).toEqual(["setup", "[x]", "u1", "a1", "u2", "a2"]);
  });

  it("returns the rows themselves when there is nothing to place, and keeps card rows stable", () => {
    expect(withLampTranscriptRows(rows, [], "t")).toBe(rows);
    expect(withLampTranscriptRows([], [session("a", "10:30")], "t")).toEqual([]);
    const sessions = [session("a", "10:30")];
    const first = withLampTranscriptRows(rows, sessions, "t");
    const previous = new Map([[first[2]!.id, first[2] as never]]);
    expect(withLampTranscriptRows([...rows], sessions, "t", previous)[2]).toBe(first[2]);
    expect(
      withLampTranscriptRows(rows, [...sessions, session("b", "10:40")], "t", previous)[2],
    ).not.toBe(first[2]);
  });

  it("parts the rows a card lands between", () => {
    const merged = withLampTranscriptRows(
      [
        { ...row("w1", "10:00"), continuesWorkLog: true },
        { ...row("w2", "10:01"), continuesWorkLog: true },
        { ...row("u1", "10:02"), groupedWithNext: true },
        { ...row("u2", "11:00"), groupedWithPrevious: true, continuesSteer: true },
      ],
      [session("a", "10:00"), session("b", "10:30")],
      "t",
    );
    expect(merged).toMatchObject([
      { id: "w1", continuesWorkLog: false },
      { kind: "lamp-transcripts" },
      { id: "w2", continuesWorkLog: true },
      { id: "u1", groupedWithNext: false },
      { kind: "lamp-transcripts" },
      { id: "u2", groupedWithPrevious: false, continuesSteer: false },
    ]);
  });
});

it("summarises a card", () => {
  expect(lampTranscriptSummary(session("a", "10:00", 1), () => "Today")).toBe("Today · 1 turn");
  expect(lampTranscriptSummary(session("a", "10:00", 4), () => "Today")).toBe("Today · 4 turns");
});
