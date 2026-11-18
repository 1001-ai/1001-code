import {
  EnvironmentId,
  type OrchestrationV2ConversationMessage,
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

const SendCall = Schema.Struct({
  arguments: Schema.Struct({
    threadId: ThreadId,
    environmentId: Schema.optional(EnvironmentId),
  }),
});
const decodeSendCall = Schema.decodeUnknownOption(SendCall);

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
 * Why an Inbox may not make this `t3_thread_send` call, or null when it may. It may send only
 * while its active run answers the user's own message, and only to another thread of its project
 * in this environment. Anything it cannot read refuses.
 */
export const inboxSendRefusal = Effect.fn("InboxAgent.sendRefusal")(
  function* (
    threads: ThreadManagementService.ThreadManagementService["Service"],
    input: {
      readonly inboxThreadId: ThreadId;
      readonly environmentId: EnvironmentId;
      readonly payload: unknown;
    },
  ) {
    const call = decodeSendCall(input.payload);
    if (Option.isNone(call)) return INBOX_SEND_UNREADABLE;
    const target = call.value.arguments;
    if (target.environmentId !== undefined && target.environmentId !== input.environmentId) {
      return INBOX_SEND_OTHER_PROJECT;
    }
    if (target.threadId === input.inboxThreadId) return INBOX_SEND_SELF;

    const inbox = yield* threads.getThreadShell(input.inboxThreadId);
    const runId = inbox?.activeRunId ?? null;
    if (inbox === null || runId === null) return INBOX_SEND_NOT_USER_STARTED;
    const { runs } = yield* threads.getThreadRecords(input.inboxThreadId, ["runs"], {
      runIds: [runId],
    });
    const run = runs.find((candidate) => candidate.id === runId);
    if (run === undefined) return INBOX_SEND_NOT_USER_STARTED;
    const { messages } = yield* threads.getThreadRecords(input.inboxThreadId, ["messages"], {
      messageIds: [run.userMessageId],
    });
    const message = messages.find((candidate) => candidate.id === run.userMessageId);
    if (message === undefined || !isUserTypedMessage(message)) return INBOX_SEND_NOT_USER_STARTED;

    const targetShell = yield* threads.getThreadShell(target.threadId);
    if (targetShell === null) return INBOX_SEND_UNREADABLE;
    if (targetShell.projectId !== inbox.projectId) return INBOX_SEND_OTHER_PROJECT;
    return null;
  },
  (effect) => effect.pipe(Effect.orElseSucceed(() => INBOX_SEND_UNREADABLE)),
);
