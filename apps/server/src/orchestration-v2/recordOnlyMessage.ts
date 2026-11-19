// Fork: a `message.dispatch` with `dispatchMode: { type: "record_only" }` records a question card
// dismissal as a user message without a run. See fork/README.md.
import type {
  OrchestrationV2Command,
  OrchestrationV2DomainEvent,
  TurnItemId,
} from "@t3tools/contracts";
import { isQuestionDismissalText } from "@t3tools/shared/questionCards";
import type * as DateTime from "effect/DateTime";

type MessageDispatch = Extract<OrchestrationV2Command, { readonly type: "message.dispatch" }>;
type EventWithoutId<Type extends OrchestrationV2DomainEvent["type"]> = Omit<
  Extract<OrchestrationV2DomainEvent, { readonly type: Type }>,
  "id"
>;

/**
 * Why a record-only message is refused, or null. Only a person's dismissal lines go in without a
 * run: anything else is meant for the agent and must reach it.
 */
export function recordOnlyMessageRefusal(command: MessageDispatch): string | null {
  return command.createdBy === "user" &&
    command.attachments.length === 0 &&
    command.guestMessageId === undefined &&
    command.notification === undefined &&
    isQuestionDismissalText(command.text)
    ? null
    : "Only question card dismissals can be recorded without starting a turn.";
}

/** The message and its timeline item, with no run, node or provider thread. */
export function recordOnlyMessageEvents(input: {
  readonly command: MessageDispatch;
  readonly turnItemId: TurnItemId;
  readonly ordinal: number;
  readonly now: DateTime.Utc;
}): readonly [EventWithoutId<"message.updated">, EventWithoutId<"turn-item.updated">] {
  const { command, now } = input;
  const origin = { createdBy: command.createdBy, creationSource: command.creationSource };
  return [
    {
      type: "message.updated",
      threadId: command.threadId,
      occurredAt: now,
      payload: {
        ...origin,
        id: command.messageId,
        threadId: command.threadId,
        runId: null,
        nodeId: null,
        role: "user",
        text: command.text,
        attachments: [],
        streaming: false,
        createdAt: now,
        updatedAt: now,
      },
    },
    {
      type: "turn-item.updated",
      threadId: command.threadId,
      occurredAt: now,
      payload: {
        ...origin,
        id: input.turnItemId,
        threadId: command.threadId,
        runId: null,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: input.ordinal,
        status: "completed",
        title: null,
        startedAt: now,
        completedAt: now,
        updatedAt: now,
        type: "user_message",
        messageId: command.messageId,
        inputIntent: "turn_start",
        text: command.text,
        attachments: [],
      },
    },
  ];
}
