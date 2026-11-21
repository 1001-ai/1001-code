import {
  EnvironmentId,
  type OrchestrationV2ConversationMessage,
  OrchestrationV2ThreadLaunchWorkspaceStrategy,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { isInboxThread } from "./inboxAgentThreads.ts";

export const INBOX_SEND_NOT_USER_STARTED =
  "The Inbox messages threads only in a turn the user started with their own message, or one another project's Inbox started. Tell the user what you would send instead.";
export const INBOX_SEND_OTHER_PROJECT =
  "The Inbox messages only its own project's threads and other projects' Inboxes, in this environment. To reach another project's thread, message that project's Inbox.";
export const INBOX_SEND_RELAYED =
  "In a turn another project's Inbox started, the Inbox messages only its own project's threads. Answer that Inbox in your reply instead.";
export const INBOX_SEND_NEEDS_QUEUE =
  'The Inbox messages another project\'s Inbox only as a new run. Retry with mode "queue".';
export const INBOX_SEND_SELF = "The Inbox cannot message itself.";
export const INBOX_SEND_UNREADABLE =
  "The Inbox could not confirm this send is allowed, so nothing was sent.";

export const INBOX_LAUNCH_NOT_USER_STARTED =
  "The Inbox starts threads only in a turn the user started with their own message, or one another project's Inbox started. Tell the user what thread you would start instead.";
export const INBOX_LAUNCH_OTHER_PROJECT =
  "The Inbox starts threads only in its own project in this environment. Omit projectId, environmentId and scratch.";
export const INBOX_LAUNCH_DELEGATED = "The Inbox cannot start delegated tasks. Omit delegatedFrom.";
export const INBOX_LAUNCH_NEEDS_WORKTREE =
  'The Inbox starts every thread in its own worktree. Retry with workspaceStrategy {type: "worktree", baseRef: "origin/<default branch>", startFromOrigin: true}.';
export const INBOX_LAUNCH_UNREADABLE =
  "The Inbox could not confirm this launch is allowed, so no thread was started.";

const SendCall = Schema.Struct({
  arguments: Schema.Struct({
    threadId: ThreadId,
    environmentId: Schema.optional(EnvironmentId),
    mode: Schema.optional(Schema.String),
  }),
});
const decodeSendCall = Schema.decodeUnknownOption(SendCall);

const LaunchCall = Schema.Struct({
  arguments: Schema.Struct({
    projectId: Schema.optional(ProjectId),
    environmentId: Schema.optional(EnvironmentId),
    scratch: Schema.optional(Schema.Boolean),
    workspaceStrategy: Schema.optional(OrchestrationV2ThreadLaunchWorkspaceStrategy),
    delegatedFrom: Schema.optional(Schema.Unknown),
  }),
});
const decodeLaunchCall = Schema.decodeUnknownOption(LaunchCall);

type TurnMessage = Pick<
  OrchestrationV2ConversationMessage,
  "role" | "createdBy" | "senderThreadId" | "linkedSender" | "scheduledTaskId" | "context"
>;

/** The user's own words, typed in the thread: not another agent's, a schedule's or a guest's. */
function isUserTypedMessage(message: TurnMessage): boolean {
  return (
    message.role === "user" &&
    message.createdBy === "user" &&
    message.senderThreadId === undefined &&
    message.linkedSender === undefined &&
    message.scheduledTaskId === undefined &&
    message.context?.guest === undefined
  );
}

/**
 * A `t3_thread_send` from another project's Inbox (it stamps the caller as `senderThreadId`). That
 * Inbox sends across projects only in a turn its user started, so this one is user-started too.
 */
function isInboxRelayedMessage(message: TurnMessage, inboxThreadId: ThreadId): boolean {
  return (
    message.role === "user" &&
    message.createdBy === "agent" &&
    message.senderThreadId !== undefined &&
    message.senderThreadId !== inboxThreadId &&
    isInboxThread(message.senderThreadId) &&
    message.linkedSender === undefined &&
    message.scheduledTaskId === undefined &&
    message.context?.guest === undefined
  );
}

/**
 * The Inbox's shell and who started its active run: the user's own typed message, or another
 * project's Inbox relaying one. Null for any other run: the Inbox acts on other threads only then.
 */
const actingInbox = Effect.fn("InboxAgent.actingInbox")(function* (
  threads: ThreadManagementService.ThreadManagementService["Service"],
  inboxThreadId: ThreadId,
) {
  const inbox = yield* threads.getThreadShell(inboxThreadId);
  const runId = inbox?.activeRunId ?? null;
  if (inbox === null || runId === null) return null;
  const { runs } = yield* threads.getThreadRecords(inboxThreadId, ["runs"], { runIds: [runId] });
  const run = runs.find((candidate) => candidate.id === runId);
  if (run === undefined) return null;
  const { messages } = yield* threads.getThreadRecords(inboxThreadId, ["messages"], {
    messageIds: [run.userMessageId],
  });
  const message = messages.find((candidate) => candidate.id === run.userMessageId);
  if (message === undefined) return null;
  if (isUserTypedMessage(message)) return { inbox, relayed: false };
  if (isInboxRelayedMessage(message, inboxThreadId)) return { inbox, relayed: true };
  return null;
});

interface InboxCallInput {
  readonly inboxThreadId: ThreadId;
  readonly environmentId: EnvironmentId;
  readonly payload: unknown;
}

/**
 * Why an Inbox may not make this `t3_thread_send` call, or null when it may: in this environment,
 * never to itself. A user's run may send to its project's threads and, queued, to other projects'
 * Inboxes; a run another Inbox's message started only to its project's threads, so a chain stops
 * there. Anything it cannot read refuses.
 */
export const inboxSendRefusal = Effect.fn("InboxAgent.sendRefusal")(
  function* (
    threads: ThreadManagementService.ThreadManagementService["Service"],
    input: InboxCallInput,
  ) {
    const call = decodeSendCall(input.payload);
    if (Option.isNone(call)) return INBOX_SEND_UNREADABLE;
    const target = call.value.arguments;
    if (target.environmentId !== undefined && target.environmentId !== input.environmentId) {
      return INBOX_SEND_OTHER_PROJECT;
    }
    if (target.threadId === input.inboxThreadId) return INBOX_SEND_SELF;

    const acting = yield* actingInbox(threads, input.inboxThreadId);
    if (acting === null) return INBOX_SEND_NOT_USER_STARTED;

    const targetShell = yield* threads.getThreadShell(target.threadId);
    if (targetShell === null) return INBOX_SEND_UNREADABLE;
    const ownProject = targetShell.projectId === acting.inbox.projectId;
    if (acting.relayed) return ownProject ? null : INBOX_SEND_RELAYED;
    if (ownProject) return null;
    // A user's thread titled "Inbox" is not one: only the server's record names a project's Inbox.
    if (!isInboxThread(target.threadId)) return INBOX_SEND_OTHER_PROJECT;
    // Only "queue" always starts its own run there; "auto" (the default) and steers can join the
    // Inbox's active run, which would not be the relayed turn that caps the chain.
    return target.mode === "queue" ? null : INBOX_SEND_NEEDS_QUEUE;
  },
  (effect) => effect.pipe(Effect.orElseSucceed(() => INBOX_SEND_UNREADABLE)),
);

/**
 * Why an Inbox may not make this `t3_thread_launch` call, or null when it may. It may launch only
 * while its active run answers the user's own message or another project's Inbox relaying one,
 * only in its own project in this environment, and always into a new worktree. Anything it cannot
 * read refuses.
 */
export const inboxLaunchRefusal = Effect.fn("InboxAgent.launchRefusal")(
  function* (
    threads: ThreadManagementService.ThreadManagementService["Service"],
    input: InboxCallInput,
  ) {
    const call = decodeLaunchCall(input.payload);
    if (Option.isNone(call)) return INBOX_LAUNCH_UNREADABLE;
    const launch = call.value.arguments;
    if (
      launch.scratch === true ||
      (launch.environmentId !== undefined && launch.environmentId !== input.environmentId)
    ) {
      return INBOX_LAUNCH_OTHER_PROJECT;
    }
    if (launch.delegatedFrom !== undefined) return INBOX_LAUNCH_DELEGATED;
    if (launch.workspaceStrategy?.type !== "worktree") return INBOX_LAUNCH_NEEDS_WORKTREE;

    const acting = yield* actingInbox(threads, input.inboxThreadId);
    if (acting === null) return INBOX_LAUNCH_NOT_USER_STARTED;
    if (launch.projectId !== undefined && launch.projectId !== acting.inbox.projectId) {
      return INBOX_LAUNCH_OTHER_PROJECT;
    }
    return null;
  },
  (effect) => effect.pipe(Effect.orElseSucceed(() => INBOX_LAUNCH_UNREADABLE)),
);
