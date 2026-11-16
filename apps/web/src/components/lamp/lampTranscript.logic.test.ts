import type { VoiceAgentSession } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { lampTranscriptCards, lampTranscriptSummary } from "./lampTranscript.logic";

const session = (id: string, turns = 2): VoiceAgentSession => ({
  id,
  openedAt: "2026-11-16T10:00:00.000Z",
  closedAt: "2026-11-16T10:05:00.000Z",
  turns,
});

it("shows a chat's newest voice conversations and keeps the earlier ones one click away", () => {
  // The server lists a conversation only once it is closed and something was said.
  expect(lampTranscriptCards([], false)).toEqual({ shown: [], earlier: 0 });
  const sessions = ["a", "b", "c", "d", "e"].map((id) => session(id));
  expect(lampTranscriptCards(sessions, false)).toMatchObject({
    shown: [{ id: "c" }, { id: "d" }, { id: "e" }],
    earlier: 2,
  });
  expect(lampTranscriptCards(sessions, true)).toMatchObject({ earlier: 0, shown: sessions });
  expect(lampTranscriptSummary(session("a", 1), () => "Today")).toBe("Today · 1 turn");
  expect(lampTranscriptSummary(session("a", 4), () => "Today")).toBe("Today · 4 turns");
});
