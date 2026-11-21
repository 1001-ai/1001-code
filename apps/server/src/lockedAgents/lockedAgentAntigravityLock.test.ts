import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  LOCKED_AGENT_TOOL_NAMES,
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import {
  INBOX_AGENT_INSTRUCTIONS,
  PULL_REQUEST_LINKING_INSTRUCTIONS,
  QUESTION_CARD_INSTRUCTIONS,
  REPLY_MARKER_INSTRUCTIONS,
} from "@t3tools/provider-core/server/runtimeInstructions";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";
import { expect, it } from "@effect/vitest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { ChildProcessSpawner } from "effect/process";
import type * as EffectAcpSchema from "effect-acp/compat";
import type * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";

import { recordInboxThread } from "../inboxAgent/inboxAgentThreads.ts";
import { liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import { makeAntigravityAdapterV2 } from "../orchestration-v2/Adapters/AntigravityAdapterV2.ts";
import {
  makeAntigravityAcpRuntime,
  type AntigravityAcpRuntimeInput,
} from "../provider/acp/AntigravityAcpSupport.ts";
import {
  LOCKED_AGENT_ANTIGRAVITY_DISABLED_TOOLS,
  lockAntigravityPromptForLockedAgent,
  lockAntigravityRuntimeForLockedAgent,
  lockAntigravityRuntimeInputForLockedAgent,
  lockedAgentAntigravityPermissionDisposition,
} from "./lockedAgentAntigravityLock.ts";

const chat = liveThreadShell(ThreadId.make("ag-chat-1"));
// An ordinary thread: only the server's record makes it the Inbox.
const inbox = liveThreadShell(ThreadId.make("ag-inbox-1"));
recordInboxThread(ProjectId.make("project-acme"), inbox.id);

type RuntimeInput = Omit<AntigravityAcpRuntimeInput, "spawn" | "childProcessSpawner"> & {
  readonly processEnvironment?: NodeJS.ProcessEnv;
};

/** The widest Antigravity runtime input the adapter builds: full client FS, extra MCP servers, shell fallback env. */
const fullAccess = (): RuntimeInput => ({
  cwd: "/home/user/app",
  clientFileReads: true,
  clientCapabilities: {
    fs: { readTextFile: true, writeTextFile: true },
    terminal: true,
  },
  additionalDirectories: ["/home/user/attachments", "/home/user/extra"],
  sessionSystemPromptAppend: `${PULL_REQUEST_LINKING_INSTRUCTIONS}\n\n${QUESTION_CARD_INSTRUCTIONS}\n\n${REPLY_MARKER_INSTRUCTIONS}`,
  mcpServers: [
    { type: "stdio", name: "t3-code", command: "node", args: ["mcp"], env: [] },
    { type: "stdio", name: "other", command: "node", args: ["other"], env: [] },
  ],
  acpMcpServers: [
    { type: "acp", name: "t3-code", serverId: "t3-code" },
    { type: "acp", name: "other", serverId: "other" },
  ],
  httpMcpServers: [
    { type: "http", name: "t3-code", url: "http://127.0.0.1/mcp", headers: [] },
    { type: "http", name: "other", url: "http://127.0.0.1/other", headers: [] },
  ],
  processEnvironment: {
    T3CODE_THREAD_ID: inbox.id,
    T3_ACP_MCP_ENDPOINT: "http://127.0.0.1/mcp",
    T3_ACP_MCP_AUTHORIZATION: "Bearer secret",
    T3_ACP_MCP_NODE: "/usr/bin/node",
    T3_ACP_MCP_ENTRYPOINT: "/app/bin.js",
  },
});

it("gives an Inbox thread its own tools, no shell/file tools or extra MCP servers, and Inbox instructions with project memory", () => {
  const unlocked = fullAccess();
  // The premise: without the lock this session could read files and talk to other MCP servers.
  expect(unlocked.clientFileReads).toBe(true);
  expect(unlocked.additionalDirectories).toEqual(["/home/user/attachments", "/home/user/extra"]);
  expect(unlocked.httpMcpServers?.map((server) => server.name)).toEqual(["t3-code", "other"]);

  const locked = lockAntigravityRuntimeInputForLockedAgent(
    unlocked,
    inbox,
    "<memory>project memory</memory>",
  );
  // Client file and terminal callbacks are off, and no extra directories are exposed.
  expect(locked.clientFileReads).toBe(false);
  expect(locked.clientCapabilities?.fs).toEqual({ readTextFile: false, writeTextFile: false });
  expect(locked.clientCapabilities?.terminal).toBe(false);
  expect(locked).not.toHaveProperty("additionalDirectories");
  expect(locked).not.toHaveProperty("sessionSystemPromptAppend");

  // Only T3's own MCP server stays across every transport list.
  expect(locked.mcpServers?.map((server) => server.name)).toEqual(["t3-code"]);
  expect(locked.acpMcpServers?.map((server) => server.name)).toEqual(["t3-code"]);
  expect(locked.httpMcpServers?.map((server) => server.name)).toEqual(["t3-code"]);

  // Shell-to-MCP fallback env vars are stripped.
  expect(locked.processEnvironment).toEqual({ T3CODE_THREAD_ID: inbox.id });

  // `_meta.antigravity` disables all built-ins (allowlist [] + explicit denylist), marks t3-code
  // eager, and sends Inbox instructions + project memory.
  const meta = locked.sessionMeta?.({
    protocolVersion: 1,
    agentInfo: { name: "antigravity-acp", version: "1.4.5" },
  }) as {
    readonly antigravity?: {
      readonly enabledTools?: ReadonlyArray<string>;
      readonly disabledTools?: ReadonlyArray<string>;
      readonly eagerMcpServers?: ReadonlyArray<string>;
      readonly systemPrompt?: { readonly append?: string };
    };
  };
  expect(meta?.antigravity?.enabledTools).toEqual([]);
  for (const tool of [
    "run_command",
    "view_file",
    "read_file",
    "create_file",
    "write_file",
    "edit_file",
    "list_directory",
    "search_directory",
    "find_file",
    "search_web",
    "read_url_content",
    "invoke_subagent",
    "run_workflow",
    "ask_question",
    "swarm",
  ]) {
    expect(meta?.antigravity?.disabledTools).toContain(tool);
  }
  expect(meta?.antigravity?.disabledTools).toEqual([...LOCKED_AGENT_ANTIGRAVITY_DISABLED_TOOLS]);
  expect(meta?.antigravity?.eagerMcpServers).toEqual(["t3-code"]);
  expect(meta?.antigravity?.systemPrompt).toEqual({
    append: `${INBOX_AGENT_INSTRUCTIONS}\n\n<memory>project memory</memory>`,
  });
  expect(locked.cwd).toBe("/home/user/app");
});

it("leaves every other thread's runtime input as the adapter built it", () => {
  const unlocked = fullAccess();
  expect(lockAntigravityRuntimeInputForLockedAgent(unlocked, chat, undefined)).toBe(unlocked);
  expect(lockAntigravityRuntimeInputForLockedAgent(unlocked, chat.id, undefined)).toBe(unlocked);
  expect(lockAntigravityRuntimeInputForLockedAgent(unlocked, null, undefined)).toBe(unlocked);
  expect(
    lockAntigravityRuntimeInputForLockedAgent(
      unlocked,
      { id: chat.id, lineage: { ...chat.lineage, sideChat: true, relationshipToParent: "fork" } },
      undefined,
    ),
  ).toBe(unlocked);
});

it.effect("forces a locked runtime into default mode and refuses client file reads", () =>
  Effect.gen(function* () {
    const modes: Array<string> = [];
    let registeredRead:
      | Parameters<AcpSessionRuntime.AcpSessionRuntime["Service"]["handleReadTextFile"]>[0]
      | undefined;
    const baseRuntime = {
      setMode: (modeId: string) =>
        Effect.sync(() => {
          modes.push(modeId);
          return {};
        }),
      handleReadTextFile: (
        handler: Parameters<
          AcpSessionRuntime.AcpSessionRuntime["Service"]["handleReadTextFile"]
        >[0],
      ) =>
        Effect.sync(() => {
          registeredRead = handler;
        }),
    };

    expect(lockAntigravityRuntimeForLockedAgent(baseRuntime, chat)).toBe(baseRuntime);

    const locked = lockAntigravityRuntimeForLockedAgent(baseRuntime, inbox.id);
    yield* locked.setMode("yolo");
    yield* locked.setMode("auto_edit");
    expect(modes).toEqual(["default", "default"]);

    yield* locked.handleReadTextFile(() => Effect.succeed({ content: "should never run" }));
    expect(registeredRead).toBeDefined();
    const exit = yield* registeredRead!(
      { sessionId: "session-1", path: "/home/user/app/secret.txt" },
      { requestId: "req-1", method: "fs/read_text_file" },
    ).pipe(Effect.exit);
    expect(Exit.isFailure(exit)).toBe(true);
  }),
);

it("allows only LOCKED_AGENT_TOOL_NAMES.inbox on t3-code in the permission gate and denies everything else", () => {
  const permission = (
    toolCall: Partial<EffectAcpSchema.RequestPermissionRequest["toolCall"]>,
  ): EffectAcpSchema.RequestPermissionRequest => ({
    sessionId: "session-1",
    options: [
      { optionId: "allow", name: "Allow", kind: "allow_once" },
      { optionId: "deny", name: "Deny", kind: "reject_once" },
    ],
    toolCall: { toolCallId: "tc-1", ...toolCall },
  });

  // Every Inbox tool is allowed via Antigravity 1.4.5 `_meta.mcp`, ACP `_meta.serverId`,
  // lazy `call_mcp_tool` envelope, or qualified t3-code title.
  for (const tool of LOCKED_AGENT_TOOL_NAMES.inbox) {
    expect(
      lockedAgentAntigravityPermissionDisposition(
        permission({
          title: `t3-code_${tool}`,
          kind: "other",
          _meta: { is_mcp_tool_call: true, mcp: { server: "t3-code", tool } },
        }),
        inbox.id,
      ),
    ).toBe("allow");
    expect(
      lockedAgentAntigravityPermissionDisposition(
        permission({
          title: `Permit ${tool} on t3-code`,
          kind: "other",
        }),
        inbox.id,
      ),
    ).toBe("allow");
    expect(
      lockedAgentAntigravityPermissionDisposition(
        permission({
          title: "call_mcp_tool",
          kind: "other",
          rawInput: { ServerName: "t3-code", ToolName: tool, Arguments: {} },
        }),
        inbox.id,
      ),
    ).toBe("allow");
    expect(
      lockedAgentAntigravityPermissionDisposition(
        permission({
          title: tool,
          kind: "other",
          _meta: { serverId: "t3-code", toolName: tool },
        }),
        inbox.id,
      ),
    ).toBe("allow");
  }

  // Disallowed T3 MCP tools, other MCP servers, built-ins, file locations, and questions are denied.
  for (const denied of [
    permission({
      title: "t3-code_t3_thread_interrupt",
      kind: "other",
      _meta: { is_mcp_tool_call: true, mcp: { server: "t3-code", tool: "t3_thread_interrupt" } },
    }),
    permission({
      title: "t3-code_delegate_task",
      kind: "other",
      _meta: { is_mcp_tool_call: true, mcp: { server: "t3-code", tool: "delegate_task" } },
    }),
    permission({
      title: "other_t3_thread_read",
      kind: "other",
      _meta: { is_mcp_tool_call: true, mcp: { server: "other", tool: "t3_thread_read" } },
    }),
    // Even if title looks like t3-code, authoritative `_meta.mcp` server mismatch denies.
    permission({
      title: "t3-code_t3_thread_read",
      kind: "other",
      _meta: { is_mcp_tool_call: true, mcp: { server: "evil", tool: "t3_thread_read" } },
    }),
    permission({
      title: "Run run_command?",
      kind: "execute",
      rawInput: { CommandLine: "rm -rf /" },
    }),
    permission({
      title: "t3-code_t3_thread_read",
      kind: "execute",
    }),
    permission({
      title: "t3-code_t3_thread_read",
      kind: "other",
      locations: [{ path: "/home/user/app/secret.txt" }],
    }),
    permission({
      title: "Run view_file?",
      kind: "read",
      locations: [{ path: "/home/user/app/README.md" }],
    }),
    permission({
      title: "Run edit_file?",
      kind: "edit",
    }),
    permission({
      toolCallId: "interaction_1",
      title: "t3-code_t3_thread_read",
      kind: "other",
    }),
    // Bare tool name without t3-code server qualifier is denied.
    permission({
      title: "t3_thread_read",
      kind: "other",
    }),
  ]) {
    expect(lockedAgentAntigravityPermissionDisposition(denied, inbox.id)).toBe("deny");
  }

  // Ordinary threads fall through to normal policy (`undefined`).
  expect(
    lockedAgentAntigravityPermissionDisposition(
      permission({ title: "Run run_command?", kind: "execute" }),
      chat.id,
    ),
  ).toBeUndefined();
});

it("formats Inbox prompts with project memory (and inline instructions on older runtimes) and leaves ordinary threads untouched", () => {
  expect(
    lockAntigravityPromptForLockedAgent({
      text: "What changed?",
      thread: chat,
      memory: "<memory>project memory</memory>",
      initializeResult: {
        protocolVersion: 1,
        agentInfo: { name: "antigravity-acp", version: "1.4.5" },
      },
    }),
  ).toBeUndefined();

  // 1.4.5+ already carries INBOX_AGENT_INSTRUCTIONS in `_meta.antigravity.systemPrompt.append`.
  for (const version of ["1.4.5", "1.5.0", "1.5.13"]) {
    expect(
      lockAntigravityPromptForLockedAgent({
        text: "What changed?",
        thread: inbox,
        memory: "<memory>project memory</memory>",
        initializeResult: {
          protocolVersion: 1,
          agentInfo: { name: "antigravity-acp", version },
        },
      }),
    ).toBe("<memory>project memory</memory>\n\nWhat changed?");
    expect(
      lockAntigravityPromptForLockedAgent({
        text: "What changed?",
        thread: inbox,
        memory: undefined,
        initializeResult: {
          protocolVersion: 1,
          agentInfo: { name: "antigravity-acp", version },
        },
      }),
    ).toBe("What changed?");
  }

  // Older/unknown runtimes get INBOX_AGENT_INSTRUCTIONS + project memory inline too.
  expect(
    lockAntigravityPromptForLockedAgent({
      text: "What changed?",
      thread: inbox,
      memory: "<memory>project memory</memory>",
      initializeResult: {
        protocolVersion: 1,
        agentInfo: { name: "antigravity-acp", version: "1.4.1" },
      },
    }),
  ).toBe(`${INBOX_AGENT_INSTRUCTIONS}\n\n<memory>project memory</memory>\n\nWhat changed?`);
});

const layerSession = Layer.mergeAll(
  NodeServices.layer,
  NodeCrypto.layer,
  IdAllocator.layer,
  McpProviderSessions.layer,
  TestProviderHost.layer().pipe(
    Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  ),
);

it.effect("locks an Inbox thread end-to-end through AntigravityAdapterV2", () =>
  Effect.gen(function* () {
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const crypto = yield* SecureRandom.SecureRandom;
    const mockAgentPath = yield* path.fromFileUrl(
      new URL("../../scripts/acp-mock-agent.ts", import.meta.url),
    );
    const logs = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-ag-inbox-lock-" });
    const requestLog = path.join(logs, "requests.ndjson");
    const promptReceived =
      yield* Deferred.make<
        Parameters<AcpSessionRuntime.AcpSessionRuntime["Service"]["prompt"]>[0]
      >();
    const instanceId = ProviderInstanceId.make("antigravity");
    const adapter = yield* makeAntigravityAdapterV2({
      instanceId,
      selfInvocation: yield* resolveSelfInvocation(),
      makeRuntime: (input) =>
        makeAntigravityAcpRuntime({
          ...input,
          runtimeVersion: "1.4.5",
          childProcessSpawner,
          spawn: {
            command: process.execPath,
            args: [mockAgentPath],
            cwd: input.cwd,
            env: {
              T3_ACP_ANTIGRAVITY: "1",
              T3_ACP_AGENT_VERSION: "1.4.5",
              T3_ACP_REQUEST_LOG_PATH: requestLog,
              T3_ACP_HANG_PROMPT_FOREVER: "1",
            },
          },
        }).pipe(
          Effect.provideService(SecureRandom.SecureRandom, crypto),
          Effect.map((runtime): AcpSessionRuntime.AcpSessionRuntime["Service"] => ({
            ...runtime,
            prompt: (request) =>
              Deferred.succeed(promptReceived, request).pipe(
                Effect.andThen(runtime.prompt(request)),
              ),
          })),
        ),
      withProcess: (_stop, task) => task,
      defaultModel: Effect.undefined,
    });
    const workspace = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-ag-inbox-ws-" });
    const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
      runtimeMode: "full-access",
      interactionMode: "default",
      cwd: workspace,
    });
    const inboxThreadId = ThreadId.make("ag-inbox-e2e");
    recordInboxThread(ProjectId.make("project-inbox-e2e"), inboxThreadId);
    const modelSelection = { instanceId, model: "gemini-test-low" } as const;
    const session = yield* adapter.openSession({
      threadId: inboxThreadId,
      providerSessionId: ProviderSessionId.make("provider-session-ag-inbox-e2e"),
      modelSelection,
      runtimePolicy,
    });
    const providerThread = yield* session.ensureThread({
      threadId: inboxThreadId,
      modelSelection,
      runtimePolicy,
    });
    const now = yield* DateTime.now;
    yield* session
      .startTurn({
        appThread: {
          createdBy: "system",
          creationSource: "server",
          id: inboxThreadId,
          projectId: ProjectId.make("project-inbox-e2e"),
          title: "Inbox",
          providerInstanceId: instanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: providerThread.id,
          lineage: {
            parentThreadId: null,
            relationshipToParent: null,
            rootThreadId: inboxThreadId,
          },
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
        threadId: inboxThreadId,
        runId: RunId.make("run-ag-inbox-e2e"),
        runOrdinal: 1,
        providerTurnOrdinal: 1,
        attemptId: RunAttemptId.make("attempt-ag-inbox-e2e"),
        rootNodeId: NodeId.make("node-ag-inbox-e2e"),
        providerThread,
        message: {
          createdBy: "user",
          creationSource: "web",
          messageId: MessageId.make("message-ag-inbox-e2e"),
          text: "What changed?",
          attachments: [],
        },
        modelSelection,
        runtimePolicy,
        memory: "<memory>keep answers brief</memory>",
      })
      .pipe(Effect.forkScoped);

    const promptRequest = yield* Deferred.await(promptReceived);
    const sentPrompt = JSON.stringify(promptRequest.prompt);
    expect(sentPrompt).toContain("<memory>keep answers brief</memory>");
    expect(sentPrompt).toContain("What changed?");
    expect(sentPrompt).not.toContain("<t3_code_instructions>");
    expect(sentPrompt).not.toContain("<pull_request_linking>");
    expect(sentPrompt).not.toContain("ACP fallback");
    expect(sentPrompt).not.toContain("delegate_task");

    const requests = (yield* fileSystem.readFileString(requestLog))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { method?: string; params?: Record<string, unknown> });
    const initialize = requests.find((request) => request.method === "initialize");
    expect(
      (initialize?.params?.clientCapabilities as { fs?: unknown; terminal?: unknown } | undefined)
        ?.fs,
    ).toEqual({ readTextFile: false, writeTextFile: false });
    expect(
      (initialize?.params?.clientCapabilities as { terminal?: unknown } | undefined)?.terminal,
    ).toBe(false);

    const sessionNew = requests.find((request) => request.method === "session/new");
    expect(sessionNew?.params).not.toHaveProperty("additionalDirectories");
    const agMeta = (
      sessionNew?.params?._meta as
        | {
            antigravity?: {
              enabledTools?: ReadonlyArray<string>;
              disabledTools?: ReadonlyArray<string>;
              eagerMcpServers?: ReadonlyArray<string>;
              systemPrompt?: { append?: string };
            };
          }
        | undefined
    )?.antigravity;
    expect(agMeta?.enabledTools).toEqual([]);
    expect(agMeta?.disabledTools).toEqual([...LOCKED_AGENT_ANTIGRAVITY_DISABLED_TOOLS]);
    expect(agMeta?.eagerMcpServers).toEqual(["t3-code"]);
    expect(agMeta?.systemPrompt?.append).toBe(INBOX_AGENT_INSTRUCTIONS);

    // Under `full-access`, an unlocked session switches to `"yolo"`; the locked session stays in
    // `"default"` (so `session/set_mode` is either omitted when already `"default"` or `"default"`).
    const setModeCalls = requests.filter((request) => request.method === "session/set_mode");
    expect(setModeCalls.every((call) => call.params?.modeId === "default")).toBe(true);
  }).pipe(Effect.provide(layerSession), Effect.scoped),
);
