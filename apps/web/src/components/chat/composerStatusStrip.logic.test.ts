import type { ServerProviderUsageWindow } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  formatAge,
  formatCostUsd,
  isLimitsStale,
  pickLimitWindows,
  shortWindowLabel,
  subagentTitle,
  threadCostSignal,
} from "./composerStatusStrip.logic";

const window = (
  id: string,
  kind: ServerProviderUsageWindow["kind"],
  label: string,
  usedPercent: number,
  windowDurationMins?: number,
): ServerProviderUsageWindow => ({
  id,
  kind,
  label,
  usedPercent,
  ...(windowDurationMins === undefined ? {} : { windowDurationMins }),
});

describe("pickLimitWindows", () => {
  const session = window("five_hour", "session", "Session", 38, 300);
  const scoped = window("seven_day_opus", "weekly", "Weekly · Opus", 40);
  const weekly = window("seven_day", "weekly", "Weekly", 19);

  it.each([
    {
      name: "session and overall weekly",
      windows: [scoped, session, weekly],
      ids: ["five_hour", "seven_day"],
    },
    { name: "a scoped weekly when it is the only one", windows: [scoped], ids: ["seven_day_opus"] },
    {
      name: "a nearly spent extra window",
      windows: [session, weekly, { ...scoped, usedPercent: 95 }],
      ids: ["five_hour", "seven_day", "seven_day_opus"],
    },
    {
      name: "the first window when none is session or weekly",
      windows: [window("m", "monthly", "Monthly", 10), window("o", "other", "Credits", 5)],
      ids: ["m"],
    },
  ])("shows $name", ({ windows, ids }) => {
    expect(pickLimitWindows(windows).map((picked) => picked.id)).toEqual(ids);
  });

  it("labels windows briefly", () => {
    expect([session, weekly, scoped].map(shortWindowLabel)).toEqual(["5h", "wk", "wk Opus"]);
    expect(shortWindowLabel(window("s", "session", "Session", 0))).toBe("session");
  });
});

describe("staleness", () => {
  const checkedAt = "2026-11-13T12:00:00.000Z";
  const at = (minutes: number) => Date.parse(checkedAt) + minutes * 60_000;

  it.each([
    [0, "just now", false],
    [14, "14m ago", false],
    [16, "16m ago", true],
    [180, "3h ago", true],
    [72 * 60, "3d ago", true],
  ])("after %i minutes reads %s", (minutes, age, stale) => {
    expect(formatAge(checkedAt, at(minutes))).toBe(age);
    expect(isLimitsStale(checkedAt, at(minutes))).toBe(stale);
  });
});

describe("formatting", () => {
  it.each([
    [0.004, "<$0.01"],
    [1.844, "~$1.84"],
    [99.5, "~$99.50"],
    [1234.4, "~$1,234"],
    [12_345, "~$12.3k"],
  ])("formats $%d as %s", (cost, text) => {
    expect(formatCostUsd(cost)).toBe(text);
  });

  it("titles a subagent by its title, else its prompt's first line", () => {
    expect(subagentTitle({ title: " Review ", prompt: "x" })).toBe("Review");
    expect(subagentTitle({ title: null, prompt: "\nFix the bug\nmore" })).toBe("Fix the bug");
    expect(subagentTitle({ title: null, prompt: " " })).toBe("Subagent");
  });
});

describe("threadCostSignal", () => {
  const usage = (inputTokens: number) => ({
    usageScope: "main_agent" as const,
    usageStatus: "complete" as const,
    hasSubagents: false,
    inputTokens,
    outputTokens: 10,
  });

  it("moves on a finished turn's report or a settled subagent, not on running work", () => {
    type Turn = Parameters<typeof threadCostSignal>[0]["providerTurns"][number];
    const finished: Turn = { status: "completed", turnTokenUsage: usage(100) };
    const base = { providerTurns: [finished], subagents: [{ status: "running" as const }] };
    const signal = threadCostSignal(base);
    const withTurn = (turn: Turn) => threadCostSignal({ ...base, providerTurns: [finished, turn] });

    expect(withTurn({ status: "running" })).toBe(signal);
    expect(withTurn({ status: "running", turnTokenUsage: usage(50) })).toBe(signal);
    expect(withTurn({ status: "completed", turnTokenUsage: usage(50) })).not.toBe(signal);
    expect(
      threadCostSignal({
        ...base,
        providerTurns: [{ status: "completed", turnTokenUsage: usage(150) }],
      }),
    ).not.toBe(signal);
    expect(threadCostSignal({ ...base, subagents: [{ status: "completed" }] })).not.toBe(signal);
    expect(
      threadCostSignal({ ...base, subagents: [...base.subagents, { status: "running" }] }),
    ).toBe(signal);
  });

  it("moves when a finished turn's report is refined after the fact", () => {
    const signal = threadCostSignal({
      providerTurns: [{ status: "completed", turnTokenUsage: usage(100) }],
      subagents: [],
    });
    const refined = (extra: Partial<ReturnType<typeof usage>> & Record<string, unknown>) =>
      threadCostSignal({
        providerTurns: [{ status: "completed", turnTokenUsage: { ...usage(100), ...extra } }],
        subagents: [],
      });

    expect(refined({ otherUsage: { inputTokens: 40, outputTokens: 5 } })).not.toBe(signal);
    expect(refined({ cachedInputTokens: 60 })).not.toBe(signal);
    expect(refined({ models: ["claude-haiku-5-5"] })).not.toBe(signal);
  });
});
