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

export const INBOX_SEND_NOT_USER_STARTED =
  "The Inbox messages threads only in a turn the user started with their own message. Tell the user what you would send instead.";
export const INBOX_SEND_OTHER_PROJECT = "The Inbox messages only threads of its own project.";
export const INBOX_SEND_SELF = "The Inbox cannot message itself.";
export const INBOX_SEND_UNREADABLE =
  "The Inbox could not confirm this send is allowed, so nothing was sent.";

export const INBOX_LAUNCH_NOT_USER_STARTED =
  "The Inbox starts threads only in a turn the user started with their own message. Tell the user what thread you would start instead.";
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

/** The user's own words, typed in the thread: not another agent's, a schedule's or a guest's. */
function isUserTypedMessage(
  message: Pick<
    OrchestrationV2ConversationMessage,
    "role" | "createdBy" | "senderThreadId" | "linkedSender" | "scheduledTaskId" | "context"
  >,
): boolean {
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
 * The Inbox's shell while its active run answers the user's own typed message, else null: the
 * Inbox acts on other threads only in such a run.
 */
const userStartedInbox = Effect.fn("InboxAgent.userStartedInbox")(function* (
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
  return message !== undefined && isUserTypedMessage(message) ? inbox : null;
});

interface InboxCallInput {
  readonly inboxThreadId: ThreadId;
  readonly environmentId: EnvironmentId;
  readonly payload: unknown;
}

/**
 * Why an Inbox may not make this `t3_thread_send` call, or null when it may. It may send only
 * while its active run answers the user's own message, and only to another thread of its project
 * in this environment. Anything it cannot read refuses.
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

    const inbox = yield* userStartedInbox(threads, input.inboxThreadId);
    if (inbox === null) return INBOX_SEND_NOT_USER_STARTED;

    const targetShell = yield* threads.getThreadShell(target.threadId);
    if (targetShell === null) return INBOX_SEND_UNREADABLE;
    if (targetShell.projectId !== inbox.projectId) return INBOX_SEND_OTHER_PROJECT;
    return null;
  },
  (effect) => effect.pipe(Effect.orElseSucceed(() => INBOX_SEND_UNREADABLE)),
);

/**
 * Why an Inbox may not make this `t3_thread_launch` call, or null when it may. It may launch only
 * while its active run answers the user's own message, only in its own project in this
 * environment, and always into a new worktree. Anything it cannot read refuses.
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

    const inbox = yield* userStartedInbox(threads, input.inboxThreadId);
    if (inbox === null) return INBOX_LAUNCH_NOT_USER_STARTED;
    if (launch.projectId !== undefined && launch.projectId !== inbox.projectId) {
      return INBOX_LAUNCH_OTHER_PROJECT;
    }
    return null;
  },
  (effect) => effect.pipe(Effect.orElseSucceed(() => INBOX_LAUNCH_UNREADABLE)),
);
