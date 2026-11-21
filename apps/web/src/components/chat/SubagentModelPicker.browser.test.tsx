import "~/index.css";

import {
  DEFAULT_UNIFIED_SETTINGS,
  EnvironmentId,
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2Subagent,
  type OrchestrationV2TurnItem,
  type ServerProvider,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

const state = vi.hoisted(() => ({
  providers: [] as ServerProvider[],
  subagents: [] as OrchestrationV2Subagent[],
}));

vi.mock(import("@effect/atom-react"), async (original) => ({
  ...(await original()),
  useAtomValue: ((atom: unknown, select?: (value: unknown) => unknown) => {
    const raw =
      atom === "providers"
        ? state.providers
        : atom === "thread"
          ? { projection: { subagents: state.subagents } }
          : null;
    return select ? select(raw) : raw;
  }) as never,
}));

vi.mock(import("../../state/server"), () => ({
  EMPTY_SERVER_PROVIDERS: [],
  serverEnvironment: {
    providersValueAtom: () => "providers",
    settingsValueAtom: () => "settings",
  } as never,
}));

vi.mock(import("../../state/threads"), () => ({
  environmentThreadDetails: {
    threadAtom: () => "thread",
  } as never,
}));

vi.mock(import("../../state/entities"), () => ({
  useThreadShell: (() => null) as never,
  useProject: (() => null) as never,
}));

vi.mock(import("../../state/environments"), () => ({
  useEnvironment: (() => null) as never,
}));

vi.mock(import("../../hooks/useSettings"), () => ({
  useEnvironmentSettings: (() => DEFAULT_UNIFIED_SETTINGS) as never,
}));

import { render } from "../../../test/render";
import { TooltipProvider } from "../ui/tooltip";
import { TimelineMessageSendContext } from "./questionBlockScope";
import { V2LifecycleRow } from "./V2LifecycleRow";

const environmentId = EnvironmentId.make("env-1");
const parentThreadId = ThreadId.make("thread-parent");
const childThreadId = ThreadId.make("thread-child");
const claudeInstanceId = ProviderInstanceId.make("claudeAgent");
const codexInstanceId = ProviderInstanceId.make("codex");
const now = DateTime.makeUnsafe("2026-11-21T12:00:00.000Z");

function setup(overrides?: Partial<OrchestrationV2Subagent>) {
  state.providers = [
    {
      provider: "claudeAgent",
      driver: ProviderDriverKind.make("claudeAgent"),
      instanceId: claudeInstanceId,
      displayName: "Claude",
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-11-21T00:00:00.000Z",
      slashCommands: [],
      skills: [],
      models: [
        {
          slug: "claude-opus-5-5",
          name: "Claude Opus 5.5",
          shortName: "Opus 5.5",
          isCustom: false,
          capabilities: null,
        },
        {
          slug: "claude-sonnet-5-5",
          name: "Claude Sonnet 5.5",
          shortName: "Sonnet 5.5",
          isCustom: false,
          capabilities: null,
        },
      ],
    } as unknown as ServerProvider,
    {
      provider: "codex",
      driver: ProviderDriverKind.make("codex"),
      instanceId: codexInstanceId,
      displayName: "Codex",
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-11-21T00:00:00.000Z",
      slashCommands: [],
      skills: [],
      models: [
        {
          slug: "gpt-5.4",
          name: "GPT-5.4",
          shortName: "GPT-5.4",
          isCustom: false,
          capabilities: null,
        },
      ],
    } as unknown as ServerProvider,
  ];
  const subagent: OrchestrationV2Subagent = {
    id: NodeId.make("sub-1"),
    threadId: parentThreadId,
    runId: RunId.make("run-1"),
    parentNodeId: NodeId.make("node-root"),
    origin: "app_owned",
    createdBy: "agent",
    driver: ProviderDriverKind.make("claudeAgent"),
    providerInstanceId: claudeInstanceId,
    providerThreadId: null,
    childThreadId,
    nativeTaskRef: null,
    prompt: "Review auth flow",
    title: "Review auth flow",
    model: "claude-sonnet-5-5",
    status: "running",
    progress: "Reading auth files",
    result: null,
    startedAt: now,
    completedAt: null,
    updatedAt: now,
    ...overrides,
  };
  state.subagents = [subagent];
  const item = {
    id: TurnItemId.make("item-1"),
    threadId: parentThreadId,
    runId: RunId.make("run-1"),
    sequence: 1,
    type: "subagent",
    subagentId: subagent.id,
    providerInstanceId: subagent.providerInstanceId,
    origin: subagent.origin,
    driver: subagent.driver,
    title: subagent.title,
    result: subagent.result,
    progress: subagent.progress,
    status: subagent.status,
    startedAt: subagent.startedAt,
    completedAt: subagent.completedAt,
    childThreadId: subagent.childThreadId,
  } as unknown as OrchestrationV2TurnItem;
  return item;
}

it("opens the same-provider model menu without opening the subagent thread and sends a switch message", async () => {
  const item = setup();
  const onOpenThread = vi.fn();
  const sendMessage = vi.fn(() => true);

  await using screen = await render(
    <TooltipProvider>
      <TimelineMessageSendContext value={sendMessage}>
        <V2LifecycleRow
          environmentId={environmentId}
          item={item}
          runs={[]}
          onOpenThread={onOpenThread}
        />
      </TimelineMessageSendContext>
    </TooltipProvider>,
  );

  const picker = screen.getByRole("button", { name: /Switch model for Review auth flow/ });
  await expect.element(picker).toHaveTextContent("Sonnet 5.5");

  await picker.click();
  expect(onOpenThread).not.toHaveBeenCalled();

  await expect.element(page.getByRole("menuitemradio", { name: "Opus 5.5" })).toBeVisible();
  await expect
    .element(page.getByRole("menuitemradio", { name: "Sonnet 5.5", checked: true }))
    .toBeVisible();
  expect(page.getByRole("menuitemradio", { name: "GPT-5.4" }).query()).toBeNull();

  await page.getByRole("menuitemradio", { name: "Opus 5.5" }).click();
  expect(onOpenThread).not.toHaveBeenCalled();
  expect(sendMessage).toHaveBeenCalledWith(
    'Switch the subagent "Review auth flow" (thread thread-child) to Opus 5.5 (model claude-opus-5-5) using t3_thread_configure.',
  );

  await screen.getByRole("button", { name: "Open Review auth flow" }).click();
  expect(onOpenThread).toHaveBeenCalledWith(childThreadId);
});

it("shows a static model label for finished provider-native subagents", async () => {
  const item = setup({
    origin: "provider_native",
    status: "completed",
    childThreadId: null,
    completedAt: now,
  });
  const onOpenThread = vi.fn();
  const sendMessage = vi.fn(() => true);

  await using screen = await render(
    <TooltipProvider>
      <TimelineMessageSendContext value={sendMessage}>
        <V2LifecycleRow
          environmentId={environmentId}
          item={item}
          runs={[]}
          onOpenThread={onOpenThread}
        />
      </TimelineMessageSendContext>
    </TooltipProvider>,
  );

  await expect.element(screen.getByText("Sonnet 5.5")).toBeVisible();
  expect(screen.getByRole("button", { name: /Switch model/ }).query()).toBeNull();
});
