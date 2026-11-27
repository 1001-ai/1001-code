import { type MemoryProposal, VOICE_AGENT_MEMORY_CATEGORY } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  isAllProjectsMemoryFile,
  memoryProposalInput,
  proposalForCall,
  proposalTarget,
  proposalTargetScope,
} from "./memoryProposal.logic";

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
  const call = (startedAt: string) => ({
    threadId: "thread-1",
    text: "Use tabs.",
    startedAt,
    voiceAgent: false,
    kind: null,
  });

  it("matches each call to the proposal it made when the same line was proposed twice", () => {
    expect(proposalForCall(all, call("2026-11-15T10:00:00.000Z"))?.id).toBe("first");
    expect(proposalForCall(all, call("2026-11-15T11:00:00.000Z"))?.id).toBe("second");
    // A repeat while the first was still pending got the first back.
    expect(proposalForCall([first], call("2026-11-15T10:05:00.000Z"))?.id).toBe("first");
    expect(proposalForCall(all, { ...call("2026-11-15T10:00:00.000Z"), threadId: "x" })).toBe(
      undefined,
    );
    // A voice agent call never takes a general proposal with the same text, nor the reverse.
    const voice: MemoryProposal = { ...first, id: "voice", category: VOICE_AGENT_MEMORY_CATEGORY };
    const voiceCall = { ...call("2026-11-15T10:00:00.000Z"), voiceAgent: true };
    expect(proposalForCall(all, voiceCall)).toBe(undefined);
    expect(proposalForCall([first, voice], voiceCall)?.id).toBe("voice");
    expect(proposalForCall([voice], call("2026-11-15T10:00:00.000Z"))).toBe(undefined);
  });

  it("matches a removal call to the removal of that line, never to adding it", () => {
    const removal: MemoryProposal = {
      ...first,
      id: "removal",
      kind: "remove",
      replaces: "Use tabs.",
      scope: "project",
    };
    const removalCall = memoryProposalInput({ replaces: "- Use tabs.", reason: "Outdated." })!;
    const matched = { ...call("2026-11-15T10:00:00.000Z"), ...removalCall };
    expect(proposalForCall([first, removal], matched)?.id).toBe("removal");
    expect(proposalForCall([first], matched)).toBe(undefined);
    expect(proposalForCall([removal], call("2026-11-15T10:00:00.000Z"))).toBe(undefined);
  });
});

describe("memoryProposalInput", () => {
  it("reads the proposed line and reason, and refuses a call with no line", () => {
    const general = { voiceAgent: false, replaces: null, kind: null };
    expect(memoryProposalInput({ text: "  Use tabs. ", reason: " Said twice. " })).toEqual({
      text: "Use tabs.",
      reason: "Said twice.",
      ...general,
    });
    expect(memoryProposalInput({ text: "- Use tabs.", reason: "Said twice." })).toEqual({
      text: "Use tabs.",
      reason: "Said twice.",
      ...general,
    });
    expect(memoryProposalInput({ text: "Use tabs." })).toEqual({
      text: "Use tabs.",
      reason: "",
      ...general,
    });
    expect(memoryProposalInput({ text: "  " })).toBeNull();
    expect(memoryProposalInput({ reason: "Said twice." })).toBeNull();
    expect(memoryProposalInput("Use tabs.")).toBeNull();
  });

  it("reads a change or removal of a saved line, and what a voice agent memory replaces", () => {
    expect(memoryProposalInput({ text: "- Use tabs.", replaces: "- Use spaces." })).toMatchObject({
      text: "Use tabs.",
      replaces: "Use spaces.",
      kind: "change",
    });
    expect(memoryProposalInput({ replaces: " Use spaces. " })).toMatchObject({
      text: "Use spaces.",
      replaces: "Use spaces.",
      kind: "remove",
    });
    const voice = memoryProposalInput({
      text: "Two sentences per agent.",
      category: "voice-agent-memories",
      replaces: " One sentence per agent. ",
    });
    expect(voice).toMatchObject({
      voiceAgent: true,
      replaces: "One sentence per agent.",
      kind: null,
    });
    expect(
      memoryProposalInput({ category: "voice-agent-memories", replaces: "One sentence." }),
    ).toBeNull();
    // The stored proposal wins over the call once it loads.
    expect(proposalTarget(undefined, voice)).toEqual({
      voiceAgent: true,
      replaces: "One sentence per agent.",
      kind: null,
      scope: null,
    });
    expect(proposalTarget(proposal("first", "2026-11-15T10:00:01.000Z"), voice)).toEqual({
      voiceAgent: false,
      replaces: null,
      kind: null,
      scope: null,
    });
  });

  it("maps accept choice and cross-project toggle to memory scopes and identifies all-project files", () => {
    expect(proposalTargetScope("me", false)).toBe("personal-project");
    expect(proposalTargetScope("me", true)).toBe("personal");
    expect(proposalTargetScope("team", false)).toBe("project");
    expect(proposalTargetScope("team", true)).toBe("team");

    expect(isAllProjectsMemoryFile("memory/team.md")).toBe(true);
    expect(isAllProjectsMemoryFile("memory/people/alice.md")).toBe(true);
    expect(isAllProjectsMemoryFile("memory/projects/web.md")).toBe(false);
    expect(isAllProjectsMemoryFile("memory/projects/web/people/alice.md")).toBe(false);
    expect(isAllProjectsMemoryFile(null)).toBe(false);
  });
});
