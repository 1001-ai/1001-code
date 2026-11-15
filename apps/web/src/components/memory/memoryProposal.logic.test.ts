import type { MemoryProposal } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { memoryProposalInput, proposalForCall } from "./memoryProposal.logic";

const proposal = (id: string, createdAt: string, text = "Use tabs."): MemoryProposal =>
  ({
    id,
    threadId: "thread-1",
    threadTitle: "Fix the build",
    text,
    reason: "",
    createdAt,
    decision: null,
  }) as MemoryProposal;

describe("proposalForCall", () => {
  const first = proposal("first", "2026-11-15T10:00:01.000Z");
  const second = proposal("second", "2026-11-15T11:00:01.000Z");
  const other = proposal("other", "2026-11-15T10:30:00.000Z", "Use spaces.");
  const all = [second, other, first];

  it("matches each call to the proposal it made when the same line was proposed twice", () => {
    const call = (startedAt: string) => ({ threadId: "thread-1", text: "Use tabs.", startedAt });
    expect(proposalForCall(all, call("2026-11-15T10:00:00.000Z"))?.id).toBe("first");
    expect(proposalForCall(all, call("2026-11-15T11:00:00.000Z"))?.id).toBe("second");
    // A repeat while the first was still pending got the first back.
    expect(proposalForCall([first], call("2026-11-15T10:05:00.000Z"))?.id).toBe("first");
    expect(proposalForCall(all, { ...call("2026-11-15T10:00:00.000Z"), threadId: "x" })).toBe(
      undefined,
    );
  });
});

describe("memoryProposalInput", () => {
  it("reads the proposed line and reason, and refuses an empty line", () => {
    expect(memoryProposalInput({ text: "  Use tabs. ", reason: " Said twice. " })).toEqual({
      text: "Use tabs.",
      reason: "Said twice.",
    });
    expect(memoryProposalInput({ text: "Use tabs." })).toEqual({ text: "Use tabs.", reason: "" });
    expect(memoryProposalInput({ text: "  " })).toBeNull();
    expect(memoryProposalInput("Use tabs.")).toBeNull();
  });
});
