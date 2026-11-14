import { describe, expect, it } from "@effect/vitest";

import { FORK_UPDATES_MESSAGE } from "./forkBuild.ts";
import { managedUpdatesDenial, type ManagedPolicySummary } from "./managedPolicy.ts";

const managed = (mode: "auto" | "off"): ManagedPolicySummary => ({
  organization: "Example Corp",
  lockedSettings: [],
  limits: { updates: { mode } },
});

describe("managedUpdatesDenial", () => {
  it.each([
    { name: "no policy", summary: undefined, denial: FORK_UPDATES_MESSAGE },
    {
      name: "a policy that allows updates",
      summary: managed("auto"),
      denial: FORK_UPDATES_MESSAGE,
    },
    {
      name: "a policy that turns them off",
      summary: managed("off"),
      denial: "Example Corp manages T3 Code updates.",
    },
  ])("denies updates under $name", ({ summary, denial }) => {
    expect(managedUpdatesDenial(summary)).toBe(denial);
  });
});
