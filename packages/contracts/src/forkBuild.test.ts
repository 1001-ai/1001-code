import { describe, expect, it } from "@effect/vitest";

import { FORK_UPDATES_MESSAGE, forkBuildDevEnvNames, forkBuildEnvDefaults } from "./forkBuild.ts";
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

describe("forkBuildEnvDefaults", () => {
  const baked = { T3CODE_LINEAR_CLIENT_ID: "baked-client", T3CODE_TEAM_CATALOG: "baked-catalog" };

  it.each([
    { name: "an empty environment", env: {}, defaults: baked },
    {
      name: "a variable set at launch",
      env: { T3CODE_TEAM_CATALOG: "launch-catalog" },
      defaults: { T3CODE_LINEAR_CLIENT_ID: "baked-client" },
    },
    { name: "a blank variable", env: { T3CODE_TEAM_CATALOG: " " }, defaults: baked },
  ])("fills only what $name leaves unset", ({ env, defaults }) => {
    expect(forkBuildEnvDefaults(baked, env)).toEqual(defaults);
  });

  it("bakes only the listed settings, and only those with a value", () => {
    expect(
      forkBuildEnvDefaults({ T3CODE_LINEAR_CLIENT_ID: "", T3CODE_PORT: "1", HOME: "/x" }, {}),
    ).toEqual({});
  });
});

describe("forkBuildDevEnvNames", () => {
  it("names the dev app variables that are set, ignoring blank ones", () => {
    expect(
      forkBuildDevEnvNames({
        T3CODE_DESKTOP_DEV: "1",
        VITE_HTTP_URL: "http://127.0.0.1:1234",
        VITE_WS_URL: " ",
        T3CODE_TEAM_CATALOG: "catalog",
      }),
    ).toEqual(["T3CODE_DESKTOP_DEV", "VITE_HTTP_URL"]);
  });
});
