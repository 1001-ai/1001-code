import { describe, expect, it } from "@effect/vitest";

import { FORK_UPDATES_MESSAGE, forkShareLinkOrigin } from "./forkBuild.ts";
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

describe("forkShareLinkOrigin", () => {
  it.each([
    {
      name: "the named hosted app",
      hosted: "https://hosted.example.test",
      from: "https://env.example.test/x",
      origin: "https://hosted.example.test",
    },
    {
      name: "the web origin serving the client",
      hosted: undefined,
      from: "https://env.example.test:3773/settings",
      origin: "https://env.example.test:3773",
    },
    {
      name: "a loopback web origin",
      hosted: undefined,
      from: "http://localhost:5733/",
      origin: "http://localhost:5733",
    },
    {
      name: "nothing in the desktop app",
      hosted: undefined,
      from: "t3code://app/index.html",
      origin: undefined,
    },
    { name: "nothing without a location", hosted: undefined, from: undefined, origin: undefined },
  ])("links through $name", ({ hosted, from, origin }) => {
    expect(forkShareLinkOrigin(hosted, from)).toBe(origin);
  });
});
