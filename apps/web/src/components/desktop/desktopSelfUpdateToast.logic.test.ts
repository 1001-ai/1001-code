import { describe, expect, it } from "vite-plus/test";

import { restartConfirmation, selfUpdateToast } from "./desktopSelfUpdateToast.logic";

describe("selfUpdateToast", () => {
  it.each([
    [null, null],
    [{ status: "idle" } as const, null],
    [
      { status: "building" } as const,
      { kind: "building", title: "Updating 1001 Code", description: "Building the new version…" },
    ],
    [{ status: "ready" } as const, { kind: "ready", title: "Update ready" }],
    [
      { status: "error", message: "The build failed." } as const,
      { kind: "error", title: "Update failed", description: "The build failed." },
    ],
  ])("shows %j as %j", (state, toast) => {
    expect(selfUpdateToast(state, "1001 Code")).toEqual(toast);
  });
});

describe("restartConfirmation", () => {
  it.each([
    [0, 0, null],
    [
      0,
      1,
      {
        title: "1 agent is running",
        description: "Restarting stops it. It continues when 1001 Code reopens.",
      },
    ],
    [
      0,
      2,
      {
        title: "2 agents are running",
        description: "Restarting stops them. They continue when 1001 Code reopens.",
      },
    ],
    [1, 0, { title: "1 agent is running", description: "Restarting stops it." }],
    [2, 0, { title: "2 agents are running", description: "Restarting stops them." }],
    // Only some would continue, so promising that they all continue would be wrong.
    [1, 2, { title: "3 agents are running", description: "Restarting stops them." }],
  ])("asks for %i stopped and %i continuing agents", (stopped, continuing, confirmation) => {
    expect(restartConfirmation({ stopped, continuing, appName: "1001 Code" })).toEqual(
      confirmation,
    );
  });
});
