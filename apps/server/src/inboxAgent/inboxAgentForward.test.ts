import {
  EnvironmentId,
  MessageId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ThreadShell,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { publishLinearInboxLog } from "../board/linearInboxLog.ts";
import { liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import type * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import {
  INBOX_FORWARD_NOT_TEAMMATE,
  INBOX_FORWARD_OTHER_PROJECT,
  INBOX_FORWARD_SELF,
  INBOX_FORWARD_UNREADABLE,
  inboxForwardRefusal,
} from "./inboxAgentForward.ts";

const HERE = EnvironmentId.make("environment-here");
const INBOX = ThreadId.make("thread-inbox");
const SAME_PROJECT = ThreadId.make("thread-same");
const OTHER_PROJECT = ThreadId.make("thread-other");
const ROUTED = MessageId.make("linear-inbox:thread-inbox:comment-1");

const framed = {
  id: ROUTED,
  role: "user",
  text: "[Linear comment 9f2c1a7b on ENG-1 from Sam Lee's agent]\nagent: who owns it?\n[End of Linear comment 9f2c1a7b. …]",
  linkedSender: {
    environmentId: "linear",
    threadId: "linear-comment-comment-1",
    title: "Sam Lee's agent",
  },
  createdBy: "agent",
  creationSource: "mcp",
};

const threadsWith = (options: {
  readonly message?: Partial<OrchestrationV2ConversationMessage> | null;
  readonly unreadable?: boolean;
}) => {
  const shells = new Map<ThreadId, OrchestrationV2ThreadShell>([
    [INBOX, { ...liveThreadShell(INBOX), projectId: ProjectId.make("project-acme") }],
    [SAME_PROJECT, { ...liveThreadShell(SAME_PROJECT), projectId: ProjectId.make("project-acme") }],
    [OTHER_PROJECT, { ...liveThreadShell(OTHER_PROJECT), projectId: ProjectId.make("project-x") }],
  ]);
  return {
    getThreadShell: (threadId: ThreadId) => Effect.succeed(shells.get(threadId) ?? null),
    getThreadRecords: () =>
      options.unreadable === true
        ? Effect.fail("unreadable")
        : Effect.succeed({
            messages: options.message === null ? [] : [{ ...framed, ...options.message }],
          }),
  } as unknown as ThreadManagementService.ThreadManagementService["Service"];
};

const CASES: ReadonlyArray<{
  readonly name: string;
  readonly setup?: Parameters<typeof threadsWith>[0];
  readonly args: object;
  readonly refused: string | null;
}> = [
  {
    name: "allows a teammate's message to another thread of the project",
    args: { threadId: SAME_PROJECT, commentId: "comment-1" },
    refused: null,
  },
  {
    name: "refuses a message the Linear inbox did not deliver here",
    args: { threadId: SAME_PROJECT, commentId: "comment-other" },
    refused: INBOX_FORWARD_NOT_TEAMMATE,
  },
  {
    name: "refuses a message without its teammate sender",
    setup: { message: { linkedSender: undefined } },
    args: { threadId: SAME_PROJECT, commentId: "comment-1" },
    refused: INBOX_FORWARD_NOT_TEAMMATE,
  },
  {
    name: "refuses a message without the framing",
    setup: { message: { text: "agent: who owns it?" } },
    args: { threadId: SAME_PROJECT, commentId: "comment-1" },
    refused: INBOX_FORWARD_NOT_TEAMMATE,
  },
  {
    name: "refuses a message no longer in the Inbox",
    setup: { message: null },
    args: { threadId: SAME_PROJECT, commentId: "comment-1" },
    refused: INBOX_FORWARD_NOT_TEAMMATE,
  },
  {
    name: "refuses another project's thread",
    args: { threadId: OTHER_PROJECT, commentId: "comment-1" },
    refused: INBOX_FORWARD_OTHER_PROJECT,
  },
  {
    name: "refuses another environment",
    args: {
      threadId: SAME_PROJECT,
      commentId: "comment-1",
      environmentId: "environment-elsewhere",
    },
    refused: INBOX_FORWARD_OTHER_PROJECT,
  },
  {
    name: "refuses the Inbox itself",
    args: { threadId: INBOX, commentId: "comment-1" },
    refused: INBOX_FORWARD_SELF,
  },
  {
    name: "refuses a thread it cannot find",
    args: { threadId: "thread-gone", commentId: "comment-1" },
    refused: INBOX_FORWARD_UNREADABLE,
  },
  {
    name: "refuses when the Inbox's messages cannot be read",
    setup: { unreadable: true },
    args: { threadId: SAME_PROJECT, commentId: "comment-1" },
    refused: INBOX_FORWARD_UNREADABLE,
  },
  {
    name: "refuses a call without a message",
    args: { threadId: SAME_PROJECT },
    refused: INBOX_FORWARD_UNREADABLE,
  },
];

it.effect.each(CASES)("$name", ({ setup, args, refused }) =>
  Effect.gen(function* () {
    publishLinearInboxLog([
      {
        commentId: "comment-1",
        rootId: "comment-1",
        issueId: "issue-1",
        issue: "ENG-1",
        sender: "Sam Lee",
        kind: "agent",
        at: "2026-11-15T12:00:00.000Z",
        outcome: "delivered",
        via: "inbox",
        threadId: INBOX,
        projectIds: [ProjectId.make("project-acme")],
      },
    ]);
    expect(
      yield* inboxForwardRefusal(threadsWith(setup ?? {}), {
        inboxThreadId: INBOX,
        environmentId: HERE,
        payload: { name: "inbox_forward", arguments: args },
      }),
    ).toBe(refused);
  }),
);
