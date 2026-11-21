import {
  ANTIGRAVITY_DEFAULT_MODEL,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ServerProvider,
} from "@t3tools/contracts";
import type { UnifiedSettings } from "@t3tools/contracts/settings";
import { describe, expect, it } from "vite-plus/test";

import {
  appendMessageToDraft,
  canSwitchSubagentModel,
  resolveSubagentModelLabel,
  subagentModelSwitchMessage,
  subagentSelectableModels,
} from "./subagentModelSwitch.logic";

const claudeProvider = (models?: ServerProvider["models"]): ServerProvider =>
  ({
    provider: "claudeAgent",
    driver: ProviderDriverKind.make("claudeAgent"),
    instanceId: ProviderInstanceId.make("claudeAgent"),
    displayName: "Claude",
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-11-21T00:00:00.000Z",
    slashCommands: [],
    skills: [],
    models: models ?? [
      { slug: "claude-opus-5-5", name: "Claude Opus 5.5", shortName: "Opus 5.5", isCustom: false },
      {
        slug: "claude-sonnet-5-5",
        name: "Claude Sonnet 5.5",
        shortName: "Sonnet 5.5",
        isCustom: false,
      },
      {
        slug: "claude-haiku-5-5",
        name: "Claude Haiku 5.5",
        shortName: "Haiku 5.5",
        isCustom: false,
      },
      {
        slug: "claude-sonnet-3-5",
        name: "Claude Sonnet 3.5",
        shortName: "Sonnet 3.5",
        isCustom: false,
        isLegacy: true,
      },
    ],
  }) as unknown as ServerProvider;

describe("canSwitchSubagentModel", () => {
  const childThreadId = ThreadId.make("thread-child");
  const remote = {
    environmentId: EnvironmentId.make("env-remote"),
    threadId: ThreadId.make("thread-remote"),
    label: "Mac Mini",
  };

  it.each([
    {
      name: "running native subagent",
      input: {
        status: "running" as const,
        origin: "provider_native" as const,
        childThreadId: null,
      },
      expected: true,
    },
    {
      name: "pending native subagent",
      input: {
        status: "pending" as const,
        origin: "provider_native" as const,
        childThreadId: null,
      },
      expected: true,
    },
    {
      name: "waiting native subagent",
      input: {
        status: "waiting" as const,
        origin: "provider_native" as const,
        childThreadId: null,
      },
      expected: true,
    },
    {
      name: "idle resumable native subagent",
      input: { status: "idle" as const, origin: "provider_native" as const, childThreadId: null },
      expected: true,
    },
    {
      name: "completed native subagent",
      input: {
        status: "completed" as const,
        origin: "provider_native" as const,
        childThreadId: null,
      },
      expected: false,
    },
    {
      name: "failed native subagent",
      input: { status: "failed" as const, origin: "provider_native" as const, childThreadId: null },
      expected: false,
    },
    {
      name: "completed delegated subagent with child thread",
      input: { status: "completed" as const, origin: "app_owned" as const, childThreadId },
      expected: true,
    },
    {
      name: "completed remote delegated subagent",
      input: {
        status: "completed" as const,
        origin: "app_owned" as const,
        childThreadId: null,
        remote,
      },
      expected: true,
    },
    {
      name: "running delegated subagent before thread id is assigned",
      input: { status: "running" as const, origin: "app_owned" as const, childThreadId: null },
      expected: false,
    },
    {
      name: "completed delegated subagent without thread",
      input: { status: "completed" as const, origin: "app_owned" as const, childThreadId: null },
      expected: false,
    },
  ])("$name -> $expected", ({ input, expected }) => {
    expect(canSwitchSubagentModel(input)).toBe(expected);
  });
});

describe("resolveSubagentModelLabel", () => {
  const provider = claudeProvider();

  it("resolves a catalog model to its short name", () => {
    expect(resolveSubagentModelLabel({ model: "claude-sonnet-5-5", provider })).toEqual({
      modelLabel: "Sonnet 5.5",
      modelSlug: "claude-sonnet-5-5",
    });
  });

  it("prefers executedModel over model and falls back to modelSelection", () => {
    expect(
      resolveSubagentModelLabel({
        model: "claude-haiku-5-5",
        executedModel: "claude-opus-5-5",
        provider,
      }),
    ).toEqual({ modelLabel: "Opus 5.5", modelSlug: "claude-opus-5-5" });

    expect(
      resolveSubagentModelLabel({
        model: null,
        modelSelection: { model: "claude-haiku-5-5" },
        provider,
      }),
    ).toEqual({ modelLabel: "Haiku 5.5", modelSlug: "claude-haiku-5-5" });
  });

  it("returns nulls when no model was reported", () => {
    expect(resolveSubagentModelLabel({ model: null, provider })).toEqual({
      modelLabel: null,
      modelSlug: null,
    });
  });
});

describe("subagentSelectableModels", () => {
  it("lists only non-legacy models from the subagent's provider and marks the current one", () => {
    const items = subagentSelectableModels({
      provider: claudeProvider(),
      settings: null,
      currentModelSlug: "claude-sonnet-5-5",
    });
    expect(items).toEqual([
      { slug: "claude-opus-5-5", label: "Opus 5.5", isCurrent: false },
      { slug: "claude-sonnet-5-5", label: "Sonnet 5.5", isCurrent: true },
      { slug: "claude-haiku-5-5", label: "Haiku 5.5", isCurrent: false },
    ]);
  });

  it("keeps a legacy model when it is the subagent's current model", () => {
    const items = subagentSelectableModels({
      provider: claudeProvider(),
      settings: null,
      currentModelSlug: "claude-sonnet-3-5",
    });
    expect(items.find((item) => item.slug === "claude-sonnet-3-5")).toEqual({
      slug: "claude-sonnet-3-5",
      label: "Sonnet 3.5",
      isCurrent: true,
    });
  });

  it("respects hidden models and custom ordering from settings", () => {
    const settings = {
      providerModelPreferences: {
        claudeAgent: {
          hiddenModels: ["claude-haiku-5-5"],
          modelOrder: ["claude-sonnet-5-5", "claude-opus-5-5"],
        },
      },
    } as unknown as UnifiedSettings;
    const items = subagentSelectableModels({
      provider: claudeProvider(),
      settings,
      currentModelSlug: "claude-opus-5-5",
    });
    expect(items.map((item) => item.slug)).toEqual(["claude-sonnet-5-5", "claude-opus-5-5"]);
  });

  it("omits the antigravity default sentinel", () => {
    const agProvider = {
      ...claudeProvider([
        { slug: ANTIGRAVITY_DEFAULT_MODEL, name: "Default", isCustom: false, capabilities: null },
        { slug: "gemini-4-neon", name: "Gemini 4 Neon", isCustom: false, capabilities: null },
        { slug: "gemini-4-flash", name: "Gemini 4 Flash", isCustom: false, capabilities: null },
      ]),
      provider: "antigravity",
      driver: ProviderDriverKind.make("antigravity"),
      instanceId: ProviderInstanceId.make("antigravity"),
    } as unknown as ServerProvider;

    const items = subagentSelectableModels({
      provider: agProvider,
      settings: null,
      currentModelSlug: "gemini-4-neon",
    });
    expect(items.map((item) => item.slug)).toEqual(["gemini-4-neon", "gemini-4-flash"]);
  });
});

describe("subagentModelSwitchMessage", () => {
  it("builds a t3_thread_configure instruction for delegated local subagents", () => {
    expect(
      subagentModelSwitchMessage({
        title: "Review auth flow",
        origin: "app_owned",
        childThreadId: ThreadId.make("thread-child-42"),
        targetModelLabel: "Opus 5.5",
        targetModelSlug: "claude-opus-5-5",
      }),
    ).toBe(
      'Switch the subagent "Review auth flow" (thread thread-child-42) to Opus 5.5 (model claude-opus-5-5) using t3_thread_configure.',
    );
  });

  it("includes remote host details for delegated remote subagents", () => {
    expect(
      subagentModelSwitchMessage({
        title: "Build release",
        origin: "app_owned",
        childThreadId: null,
        remote: {
          environmentId: EnvironmentId.make("env-mini"),
          threadId: ThreadId.make("thread-remote-9"),
          label: "Mac Mini",
        },
        targetModelLabel: "GPT-5.4",
        targetModelSlug: "gpt-5.4",
      }),
    ).toBe(
      'Switch the subagent "Build release" (thread thread-remote-9 on Mac Mini, environment env-mini) to GPT-5.4 (model gpt-5.4) using t3_thread_configure.',
    );
  });

  it("builds a stop-and-restart instruction for provider-native subagents", () => {
    expect(
      subagentModelSwitchMessage({
        title: "Review\n  auth flow",
        origin: "provider_native",
        childThreadId: null,
        targetModelLabel: "Opus 5.5",
        targetModelSlug: "claude-opus-5-5",
      }),
    ).toBe(
      'Switch the subagent "Review auth flow" to Opus 5.5 (model claude-opus-5-5). If it cannot change model while it runs, stop it and start it again on that model with the same task.',
    );
  });

  it("avoids repeating the slug when label equals slug", () => {
    expect(
      subagentModelSwitchMessage({
        title: "Lint check",
        origin: "provider_native",
        childThreadId: null,
        targetModelLabel: "gpt-5.4",
        targetModelSlug: "gpt-5.4",
      }),
    ).toContain("to gpt-5.4. If it cannot change model");
  });
});

describe("appendMessageToDraft", () => {
  it("uses the message directly when the draft is empty and separates when not", () => {
    expect(appendMessageToDraft("", "Switch it")).toBe("Switch it");
    expect(appendMessageToDraft("   ", "Switch it")).toBe("Switch it");
    expect(appendMessageToDraft("Also check tests  ", "Switch it")).toBe(
      "Also check tests\n\nSwitch it",
    );
  });
});
