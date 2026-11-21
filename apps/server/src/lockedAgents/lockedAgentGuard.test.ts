import {
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { recordInboxThread } from "../inboxAgent/inboxAgentThreads.ts";
import { liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import { ProviderAdapterRegistryLookupError } from "../orchestration-v2/ProviderAdapterRegistry.ts";
import { voiceAgentThread } from "../voiceAgent/voiceAgentThread.ts";
import {
  lockedAgentCommandRefusal,
  lockedAgentMessage,
  lockedAgentRefusal,
} from "./lockedAgentGuard.ts";
import { lockedAgentProvider, lockedAgentProviders } from "./lockedAgentProvider.ts";

const claude = ProviderInstanceId.make("claudeAgent");
const claudeWork = ProviderInstanceId.make("claudeAgent-work");
const antigravity = ProviderInstanceId.make("antigravity");
const codex = ProviderInstanceId.make("codex");
const CLAUDE_DRIVER = ProviderDriverKind.make("claudeAgent");
const ANTIGRAVITY_DRIVER = ProviderDriverKind.make("antigravity");
const CODEX_DRIVER = ProviderDriverKind.make("codex");

const onProvider = (
  thread: ReturnType<typeof liveThreadShell>,
  providerInstanceId = claude,
  title = "A chat",
) => ({
  ...thread,
  title,
  providerInstanceId,
});
const chat = onProvider(liveThreadShell(ThreadId.make("chat")));
// An ordinary thread named Inbox: only the server's record makes it the Inbox.
const inbox = onProvider(liveThreadShell(ThreadId.make("inbox")), claude, "Inbox");
const inboxOnAntigravity = onProvider(
  liveThreadShell(ThreadId.make("inbox")),
  antigravity,
  "Inbox",
);
recordInboxThread(ProjectId.make("project-acme"), inbox.id);
const voice = {
  ...onProvider(liveThreadShell(ThreadId.make("voice"))),
  ...voiceAgentThread(onProvider(liveThreadShell(ThreadId.make("voice"))) as never, chat.id, chat),
};

const toCodex = {
  type: "thread.model-selection.set",
  modelSelection: { instanceId: codex, model: "gpt-5" },
};
const toAntigravity = {
  type: "thread.model-selection.set",
  modelSelection: { instanceId: antigravity, model: "gemini-3.8-flash" },
};
const toClaude = {
  type: "thread.model-selection.set",
  modelSelection: { instanceId: claude, model: "claude-opus-5-5" },
};
const toClaudeWork = {
  type: "provider.switch",
  modelSelection: { instanceId: claudeWork, model: "claude-sonnet-5-5" },
};

it("allows an Inbox thread to switch between supported locked-agent providers and refuses unsupported ones", () => {
  expect(lockedAgentRefusal(toAntigravity, inbox, ANTIGRAVITY_DRIVER)).toBeNull();
  expect(lockedAgentRefusal(toClaudeWork, inbox, CLAUDE_DRIVER)).toBeNull();
  expect(lockedAgentRefusal(toClaude, inboxOnAntigravity, CLAUDE_DRIVER)).toBeNull();
  expect(
    lockedAgentRefusal(
      {
        type: "message.dispatch",
        modelSelection: { instanceId: claude, model: "claude-opus-5-5" },
      },
      inbox,
    ),
  ).toBeNull();
  expect(lockedAgentRefusal(toCodex, inbox, CODEX_DRIVER)).toContain("supported provider");
  expect(lockedAgentRefusal(toCodex, inbox, null)).toContain("supported provider");
  expect(lockedAgentRefusal(toCodex, inbox)).toContain("supported provider");
  expect(lockedAgentRefusal(toCodex, inboxOnAntigravity, CODEX_DRIVER)).toContain(
    "supported provider",
  );
  expect(lockedAgentRefusal({ type: "thread.runtime-mode.set" }, inbox)).toBeNull();
  expect(lockedAgentMessage({ text: "hi", titleSeed: "Rename me" }, inbox)).toEqual({
    text: "hi",
  });
});

it("keeps a voice thread on its own provider instance, even when switching to Antigravity", () => {
  expect(lockedAgentRefusal(toCodex, voice, CODEX_DRIVER)).toContain("cannot change");
  expect(lockedAgentRefusal(toAntigravity, voice, ANTIGRAVITY_DRIVER)).toContain("cannot change");
  expect(lockedAgentRefusal(toClaudeWork, voice, CLAUDE_DRIVER)).toContain("cannot change");
  expect(
    lockedAgentRefusal(
      {
        type: "message.dispatch",
        modelSelection: { instanceId: claude, model: "claude-opus-5-5" },
      },
      voice,
    ),
  ).toBeNull();
  expect(lockedAgentRefusal({ type: "thread.runtime-mode.set" }, voice)).toBeNull();
  expect(lockedAgentMessage({ text: "hi", titleSeed: "Rename me" }, voice)).toEqual({
    text: "hi",
  });
});

it.effect("resolves the target driver from the adapter registry in lockedAgentCommandRefusal", () =>
  Effect.gen(function* () {
    const drivers = new Map<ProviderInstanceId, ProviderDriverKind>([
      [claude, CLAUDE_DRIVER],
      [claudeWork, CLAUDE_DRIVER],
      [antigravity, ANTIGRAVITY_DRIVER],
      [codex, CODEX_DRIVER],
    ]);
    const lookedUp: Array<ProviderInstanceId> = [];
    const adapters = {
      get: (instanceId: ProviderInstanceId) => {
        lookedUp.push(instanceId);
        const driver = drivers.get(instanceId);
        return driver === undefined
          ? Effect.fail(new ProviderAdapterRegistryLookupError({ instanceId }))
          : Effect.succeed({ driver } as never);
      },
    };

    // Ordinary threads never touch the adapter registry.
    expect(yield* lockedAgentCommandRefusal(toCodex, chat, adapters)).toBeNull();
    expect(lookedUp).toEqual([]);

    // Switching Inbox between Claude and Antigravity is allowed.
    expect(yield* lockedAgentCommandRefusal(toAntigravity, inbox, adapters)).toBeNull();
    expect(yield* lockedAgentCommandRefusal(toClaude, inboxOnAntigravity, adapters)).toBeNull();
    expect(yield* lockedAgentCommandRefusal(toClaudeWork, inbox, adapters)).toBeNull();

    // Switching Inbox to Codex or an unregistered instance is refused.
    expect(yield* lockedAgentCommandRefusal(toCodex, inbox, adapters)).toContain(
      "supported provider",
    );
    expect(
      yield* lockedAgentCommandRefusal(
        {
          type: "provider.switch",
          modelSelection: { instanceId: ProviderInstanceId.make("missing"), model: "x" },
        },
        inbox,
        adapters,
      ),
    ).toContain("supported provider");

    // Voice agent refuses switching to Antigravity too.
    expect(yield* lockedAgentCommandRefusal(toAntigravity, voice, adapters)).toContain(
      "cannot change",
    );
  }),
);

it("keeps the Inbox's name, which is how every app finds it", () => {
  const rename = (fields: object) =>
    lockedAgentRefusal({ type: "thread.metadata.update", ...fields }, inbox);
  expect(rename({ title: "My inbox" })).toContain("keeps its name");
  expect(rename({ regenerateTitle: true })).toContain("keeps its name");
  expect(rename({ title: "Inbox" })).toBeNull();
  expect(rename({ branch: null })).toBeNull();
  // The voice agent's thread may be renamed, as before.
  expect(lockedAgentRefusal({ type: "thread.metadata.update", title: "Talk" }, voice)).toBeNull();
});

it("leaves every other thread's commands alone", () => {
  expect(lockedAgentRefusal(toCodex, chat, CODEX_DRIVER)).toBeNull();
  expect(lockedAgentRefusal({ type: "thread.metadata.update", title: "Inbox" }, chat)).toBeNull();
  const command = { text: "hi", titleSeed: "A title" };
  expect(lockedAgentMessage(command, chat)).toBe(command);
});

it("selects usable providers by kind: Claude then Antigravity for Inbox, Claude only for voice", () => {
  const provider = (
    driver: ProviderDriverKind,
    instanceId: ProviderInstanceId,
    fields: Partial<ServerProvider> = {},
  ) =>
    ({
      instanceId,
      driver,
      enabled: true,
      installed: true,
      status: "ready",
      auth: { status: "authenticated" },
      ...fields,
    }) as unknown as ServerProvider;

  const usableCodex = provider(CODEX_DRIVER, codex);
  const usableAg = provider(ANTIGRAVITY_DRIVER, antigravity);
  const usableClaudeWork = provider(CLAUDE_DRIVER, claudeWork);
  const usableClaude = provider(CLAUDE_DRIVER, claude);
  const signedOutClaude = provider(CLAUDE_DRIVER, claude, {
    auth: { status: "unauthenticated" } as never,
  });

  expect(
    lockedAgentProviders([usableCodex, usableAg, usableClaudeWork, usableClaude], "inbox").map(
      (entry) => entry.instanceId,
    ),
  ).toEqual([claude, claudeWork, antigravity]);
  expect(lockedAgentProvider([usableCodex, usableAg, signedOutClaude], "inbox")?.instanceId).toBe(
    antigravity,
  );
  expect(lockedAgentProvider([usableCodex, usableAg, signedOutClaude], "voice")).toBeUndefined();
  expect(
    lockedAgentProviders([usableCodex, usableAg, usableClaudeWork, usableClaude], "voice").map(
      (entry) => entry.instanceId,
    ),
  ).toEqual([claude, claudeWork]);
});
