import {
  EnvironmentId,
  MessageId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ThreadShell,
  ProjectId,
  RunId,
  ScheduledTaskId,
  ThreadId,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import type * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import {
  INBOX_SEND_NOT_USER_STARTED,
  INBOX_SEND_OTHER_PROJECT,
  INBOX_SEND_SELF,
  INBOX_SEND_UNREADABLE,
  inboxSendRefusal,
} from "./inboxAgentSend.ts";
import { INBOX_WAKE_CREATED_BY, INBOX_WAKE_CREATION_SOURCE } from "./inboxAgentWake.ts";

const HERE = EnvironmentId.make("environment-here");
const INBOX = ThreadId.make("thread-inbox");
const SAME_PROJECT = ThreadId.make("thread-same");
const OTHER_PROJECT = ThreadId.make("thread-other");
const RUN = RunId.make("run-inbox");
const USER_MESSAGE = MessageId.make("message-user");

const shell = (id: ThreadId, projectId: string, activeRunId: RunId | null = null) => ({
  ...liveThreadShell(id, { activeRunId }),
  projectId: ProjectId.make(projectId),
});

const typedByUser = {
  id: USER_MESSAGE,
  role: "user",
  createdBy: "user",
  creationSource: "web",
} as const;

const threadsWith = (options: {
  readonly message?: Partial<OrchestrationV2ConversationMessage>;
  readonly activeRunId?: RunId | null;
  readonly unreadable?: boolean;
}) => {
  const shells = new Map<ThreadId, OrchestrationV2ThreadShell>([
    [INBOX, shell(INBOX, "project-acme", options.activeRunId === undefined ? RUN : null)],
    [SAME_PROJECT, shell(SAME_PROJECT, "project-acme")],
    [OTHER_PROJECT, shell(OTHER_PROJECT, "project-other")],
  ]);
  return {
    getThreadShell: (threadId: ThreadId) => Effect.succeed(shells.get(threadId) ?? null),
    getThreadRecords: () =>
      options.unreadable === true
        ? Effect.fail("unreadable")
        : Effect.succeed({
            runs: [{ id: RUN, userMessageId: USER_MESSAGE }],
            messages: [{ ...typedByUser, ...options.message }],
          }),
  } as unknown as ThreadManagementService.ThreadManagementService["Service"];
};

const refusal = (
  threads: ThreadManagementService.ThreadManagementService["Service"],
  args: unknown,
) =>
  inboxSendRefusal(threads, {
    inboxThreadId: INBOX,
    environmentId: HERE,
    payload: { name: "t3_thread_send", arguments: args },
  });

const CASES: ReadonlyArray<{
  readonly name: string;
  readonly setup?: Parameters<typeof threadsWith>[0];
  readonly args: object;
  readonly refused: string | null;
}> = [
  { name: "allows the user's own message", args: { threadId: SAME_PROJECT }, refused: null },
  {
    name: "allows naming this environment",
    args: { threadId: SAME_PROJECT, environmentId: HERE },
    refused: null,
  },
  {
    name: "refuses a run another agent's message started",
    setup: { message: { createdBy: "agent", creationSource: "mcp", senderThreadId: SAME_PROJECT } },
    args: { threadId: SAME_PROJECT },
    refused: INBOX_SEND_NOT_USER_STARTED,
  },
  {
    name: "refuses a run the app's wake note started",
    setup: {
      message: { createdBy: INBOX_WAKE_CREATED_BY, creationSource: INBOX_WAKE_CREATION_SOURCE },
    },
    args: { threadId: SAME_PROJECT },
    refused: INBOX_SEND_NOT_USER_STARTED,
  },
  {
    name: "refuses a scheduled run",
    setup: { message: { scheduledTaskId: ScheduledTaskId.make("task-1") } },
    args: { threadId: SAME_PROJECT },
    refused: INBOX_SEND_NOT_USER_STARTED,
  },
  {
    name: "refuses a run a guest's message started",
    setup: {
      message: {
        context: {
          version: 1,
          records: [],
          guest: { guestMessageId: "guest-1", name: "Ada", text: "hi" } as never,
        },
      },
    },
    args: { threadId: SAME_PROJECT },
    refused: INBOX_SEND_NOT_USER_STARTED,
  },
  {
    name: "refuses with no run under way",
    setup: { activeRunId: null },
    args: { threadId: SAME_PROJECT },
    refused: INBOX_SEND_NOT_USER_STARTED,
  },
  {
    name: "refuses when the run cannot be read",
    setup: { unreadable: true },
    args: { threadId: SAME_PROJECT },
    refused: INBOX_SEND_UNREADABLE,
  },
  {
    name: "refuses another project's thread",
    args: { threadId: OTHER_PROJECT },
    refused: INBOX_SEND_OTHER_PROJECT,
  },
  {
    name: "refuses another environment",
    args: { threadId: SAME_PROJECT, environmentId: "environment-elsewhere" },
    refused: INBOX_SEND_OTHER_PROJECT,
  },
  { name: "refuses the Inbox itself", args: { threadId: INBOX }, refused: INBOX_SEND_SELF },
  {
    name: "refuses a thread it cannot read",
    args: { threadId: "thread-gone" },
    refused: INBOX_SEND_UNREADABLE,
  },
  { name: "refuses a call with no target", args: {}, refused: INBOX_SEND_UNREADABLE },
];

it.effect.each(CASES)("$name", ({ setup, args, refused }) =>
  Effect.gen(function* () {
    expect(yield* refusal(threadsWith(setup ?? {}), args)).toBe(refused);
  }),
);
