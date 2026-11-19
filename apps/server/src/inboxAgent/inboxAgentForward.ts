import {
  EnvironmentId,
  MessageId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ThreadShell,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { type LinearInboxLogEntry, deliveredTo, linearInboxLog } from "../board/linearInboxLog.ts";
import { FRAMED_COMMENT_START, inboxMessageKey } from "../board/linearInboxRouting.ts";
import type * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";

export const INBOX_FORWARD_NOT_TEAMMATE =
  "Only a teammate's message that arrived in this Inbox can be forwarded, by the commentId its closing marker gives.";
export const INBOX_FORWARD_OTHER_PROJECT = "The Inbox forwards only to threads of its own project.";
export const INBOX_FORWARD_SELF = "The Inbox cannot forward a message to itself.";
export const INBOX_FORWARD_UNREADABLE =
  "The Inbox could not confirm this forward is allowed, so nothing was sent.";

export const InboxForwardArguments = Schema.Struct({
  threadId: ThreadId,
  /** The Linear comment the message carries; the model sees it, unlike the message's id. */
  commentId: Schema.String,
  environmentId: Schema.optional(EnvironmentId),
});
export type InboxForwardArguments = typeof InboxForwardArguments.Type;

const decodeForwardCall = Schema.decodeUnknownOption(
  Schema.Struct({ arguments: InboxForwardArguments }),
);

export type InboxForwardCheck =
  | { readonly _tag: "refused"; readonly reason: string }
  | {
      readonly _tag: "allowed";
      /** How the message reached the Inbox. */
      readonly entry: LinearInboxLogEntry;
      readonly message: OrchestrationV2ConversationMessage;
      readonly target: OrchestrationV2ThreadShell;
    };

const refused = (reason: string): InboxForwardCheck => ({ _tag: "refused", reason });

/**
 * Whether an Inbox may forward this message to this thread: the message must be a teammate's
 * message the Linear inbox delivered to this Inbox (its log says so, and the message still has
 * its sender and framing), and the target another thread of the Inbox's project in this
 * environment. Anything it cannot read refuses.
 */
export const inboxForwardCheck = Effect.fn("InboxAgent.forwardCheck")(
  function* (
    threads: ThreadManagementService.ThreadManagementService["Service"],
    input: {
      readonly inboxThreadId: ThreadId;
      readonly environmentId: EnvironmentId;
      readonly forward: InboxForwardArguments;
    },
  ) {
    const { forward, inboxThreadId } = input;
    if (forward.environmentId !== undefined && forward.environmentId !== input.environmentId) {
      return refused(INBOX_FORWARD_OTHER_PROJECT);
    }
    if (forward.threadId === inboxThreadId) return refused(INBOX_FORWARD_SELF);
    const entry = deliveredTo(linearInboxLog(), inboxThreadId, forward.commentId);
    if (entry === undefined) return refused(INBOX_FORWARD_NOT_TEAMMATE);
    const messageId = MessageId.make(inboxMessageKey(inboxThreadId, forward.commentId));
    const { messages } = yield* threads.getThreadRecords(inboxThreadId, ["messages"], {
      messageIds: [messageId],
    });
    const message = messages.find((candidate) => candidate.id === messageId);
    if (
      message === undefined ||
      message.role !== "user" ||
      message.linkedSender === undefined ||
      !FRAMED_COMMENT_START.test(message.text)
    ) {
      return refused(INBOX_FORWARD_NOT_TEAMMATE);
    }
    const inbox = yield* threads.getThreadShell(inboxThreadId);
    const target = yield* threads.getThreadShell(forward.threadId);
    if (inbox === null || target === null) return refused(INBOX_FORWARD_UNREADABLE);
    if (target.projectId !== inbox.projectId) return refused(INBOX_FORWARD_OTHER_PROJECT);
    return { _tag: "allowed", entry, message, target } satisfies InboxForwardCheck;
  },
  (effect) => effect.pipe(Effect.orElseSucceed(() => refused(INBOX_FORWARD_UNREADABLE))),
);

/** Why the gate refuses an Inbox's `inbox_forward` call, or null when it may run. */
export const inboxForwardRefusal = Effect.fn("InboxAgent.forwardRefusal")(function* (
  threads: ThreadManagementService.ThreadManagementService["Service"],
  input: {
    readonly inboxThreadId: ThreadId;
    readonly environmentId: EnvironmentId;
    readonly payload: unknown;
  },
) {
  const call = decodeForwardCall(input.payload);
  if (Option.isNone(call)) return INBOX_FORWARD_UNREADABLE;
  const check = yield* inboxForwardCheck(threads, {
    inboxThreadId: input.inboxThreadId,
    environmentId: input.environmentId,
    forward: call.value.arguments,
  });
  return check._tag === "refused" ? check.reason : null;
});
