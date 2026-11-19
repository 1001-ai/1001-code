import {
  ComposerContextId,
  type ComposerContextRecord,
  COMPOSER_CONTEXT_MAX_RECORDS,
  INBOX_AGENT_DIGEST_CONTEXT_KIND,
  INBOX_AGENT_DIGEST_DETAIL_MAX_LENGTH,
  INBOX_AGENT_DIGEST_LABEL,
  INBOX_AGENT_DIGEST_MAX_ENTRIES,
  INBOX_AGENT_DIGEST_TITLE_MAX_LENGTH,
  type InboxAgentDigest,
  type InboxAgentDigestEntry,
  type OrchestrationMessageContext,
  type OrchestrationV2AppThread,
  type OrchestrationV2Command,
  type OrchestrationV2ThreadShell,
  type ProjectId,
  type ThreadId,
  inboxAgentDigestOf,
  isListedThreadLineage,
} from "@t3tools/contracts";
import {
  inboxAgentPlainText,
  withInboxAgentDigest,
} from "@t3tools/provider-core/server/runtimeInstructions";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { type LinearInboxLogEntry, linearInboxLog } from "../board/linearInboxLog.ts";
import { skipReasonText } from "../board/linearInboxRouting.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { isInboxThread } from "./inboxAgentThreads.ts";

/** The first message to the Inbox looks back this far. */
const FIRST_DIGEST_LOOKBACK_MS = 24 * 60 * 60 * 1000;
const DIGEST_CONTEXT_ID = ComposerContextId.make("inbox-digest");

type DigestShell = Pick<
  OrchestrationV2ThreadShell,
  | "id"
  | "projectId"
  | "title"
  | "lineage"
  | "createdAt"
  | "status"
  | "lastError"
  | "latestRunRequestedAt"
  | "latestRunStartedAt"
  | "latestRunCompletedAt"
  | "openQuestionsAt"
  | "pendingRuntimeRequest"
  | "pullRequests"
>;

function clip(text: string, max: number): string {
  const plain = inboxAgentPlainText(text);
  return plain.length <= max ? plain : `${plain.slice(0, max - 1)}…`;
}

const iso = (millis: number) => DateTime.formatIso(DateTime.makeUnsafe(millis));

/**
 * What changed in one project's listed threads in (`sinceMs`, `untilMs`], with teammates'
 * messages from the Linear inbox's log. Side chats, subagents, other projects and the Inbox
 * itself are left out. Newest first; the oldest are cut past the cap.
 */
export function inboxAgentDigest(input: {
  readonly shells: ReadonlyArray<DigestShell>;
  readonly projectId: ProjectId;
  readonly inboxThreadId: ThreadId;
  readonly sinceMs: number;
  readonly untilMs: number;
  readonly messages?: ReadonlyArray<LinearInboxLogEntry>;
}): InboxAgentDigest {
  const entries: Array<InboxAgentDigestEntry & { readonly ms: number }> = [];
  const inWindow = (time: DateTime.Utc | null | undefined): number | null => {
    if (time === null || time === undefined) return null;
    const ms = DateTime.toEpochMillis(time);
    return ms > input.sinceMs && ms <= input.untilMs ? ms : null;
  };
  for (const shell of input.shells) {
    if (
      shell.projectId !== input.projectId ||
      shell.id === input.inboxThreadId ||
      isInboxThread(shell.id) ||
      !isListedThreadLineage(shell.lineage)
    ) {
      continue;
    }
    const title = clip(shell.title, INBOX_AGENT_DIGEST_TITLE_MAX_LENGTH);
    const add = (
      kind: InboxAgentDigestEntry["kind"],
      ms: number,
      detail?: string | null | undefined,
    ) =>
      entries.push({
        kind,
        threadId: shell.id,
        title,
        at: iso(ms),
        ms,
        ...(detail === null || detail === undefined || detail.trim() === ""
          ? {}
          : { detail: clip(detail, INBOX_AGENT_DIGEST_DETAIL_MAX_LENGTH) }),
      });

    const created = inWindow(shell.createdAt);
    if (created !== null) add("thread-created", created);

    // The shell keeps only the latest run: one that is still going hides any earlier outcome.
    const completedAt = shell.latestRunCompletedAt ?? null;
    const started =
      completedAt === null
        ? inWindow(shell.latestRunStartedAt ?? shell.latestRunRequestedAt)
        : null;
    if (started !== null) add("run-started", started);
    const finished = inWindow(completedAt);
    if (finished !== null) {
      if (shell.status === "failed") add("run-failed", finished, shell.lastError ?? undefined);
      else
        add(
          "run-finished",
          finished,
          shell.status === "interrupted" || shell.status === "cancelled" ? "stopped" : undefined,
        );
    }

    const questions = inWindow(shell.openQuestionsAt);
    const request = shell.pendingRuntimeRequest;
    const requested =
      request === null || request.kind === "auth_refresh" ? null : inWindow(request.createdAt);
    if (questions !== null) add("question", questions, "asks the user a question");
    else if (requested !== null && request !== null) {
      add(
        "question",
        requested,
        request.kind === "user_input" ? "asks the user a question" : "waits for an approval",
      );
    }

    for (const link of shell.pullRequests ?? []) {
      if (link.source === "stack-dismissed") continue;
      const linked = inWindow(DateTime.makeUnsafe(link.linkedAt));
      if (linked === null) continue;
      add(
        "pull-request",
        linked,
        link.snapshot === null ? link.url : `${link.url} ${link.snapshot.title}`,
      );
    }
  }
  const titles = new Map(input.shells.map((shell) => [shell.id, shell.title]));
  const titleOf = (threadId: ThreadId | undefined) =>
    threadId === input.inboxThreadId
      ? "the Inbox"
      : threadId === undefined
        ? "a thread"
        : `"${titles.get(threadId) ?? "a thread"}"`;
  for (const message of input.messages ?? []) {
    if (!message.projectIds.includes(input.projectId)) continue;
    const ms = Date.parse(message.at);
    if (!(ms > input.sinceMs && ms <= input.untilMs)) continue;
    const from = message.kind === "agent" ? `${message.sender}'s agent` : message.sender;
    const detail =
      message.outcome === "not-delivered"
        ? `Not delivered: ${skipReasonText(message.reason)}.`
        : message.via === "forward"
          ? `Forwarded by the Inbox to ${titleOf(message.threadId)}.`
          : `Delivered to ${titleOf(message.threadId)}.`;
    entries.push({
      kind: message.outcome === "delivered" ? "message-received" : "message-not-delivered",
      threadId: message.threadId ?? input.inboxThreadId,
      title: clip(`${message.issue} from ${from}`, INBOX_AGENT_DIGEST_TITLE_MAX_LENGTH),
      at: iso(ms),
      ms,
      detail: clip(detail, INBOX_AGENT_DIGEST_DETAIL_MAX_LENGTH),
    });
  }
  entries.sort((left, right) => right.ms - left.ms);
  const kept = entries
    .slice(0, INBOX_AGENT_DIGEST_MAX_ENTRIES)
    .map(({ ms: _ms, ...entry }) => entry);
  return {
    since: iso(input.sinceMs),
    until: iso(input.untilMs),
    entries: kept,
    omitted: entries.length - kept.length,
  };
}

/** Where the digest starts: the user's previous Inbox message, or a day back for the first. */
export function inboxAgentDigestSinceMs(
  inbox: Pick<OrchestrationV2ThreadShell, "latestUserAuthoredMessageAt" | "latestUserMessageAt">,
  untilMs: number,
): number {
  const previous = inbox.latestUserAuthoredMessageAt ?? inbox.latestUserMessageAt ?? null;
  return previous === null ? untilMs - FIRST_DIGEST_LOOKBACK_MS : DateTime.toEpochMillis(previous);
}

function withoutDigestRecord(
  context: OrchestrationMessageContext | undefined,
): OrchestrationMessageContext | undefined {
  if (context?.records.some((record) => record.kind === INBOX_AGENT_DIGEST_CONTEXT_KIND) !== true) {
    return context;
  }
  return {
    ...context,
    records: context.records.filter((record) => record.kind !== INBOX_AGENT_DIGEST_CONTEXT_KIND),
  };
}

/** The user's message with the digest as one more context record, which the message keeps. */
function withInboxAgentDigestRecord(
  context: OrchestrationMessageContext | undefined,
  digest: InboxAgentDigest,
): OrchestrationMessageContext | undefined {
  const base = withoutDigestRecord(context);
  if ((base?.records.length ?? 0) >= COMPOSER_CONTEXT_MAX_RECORDS) return base;
  const record = {
    version: 1,
    contextId: DIGEST_CONTEXT_ID,
    label: INBOX_AGENT_DIGEST_LABEL,
    kind: INBOX_AGENT_DIGEST_CONTEXT_KIND,
    payload: digest,
  } as ComposerContextRecord;
  return {
    version: 1,
    ...base,
    records: [...(base?.records ?? []), record],
  };
}

type MessageDispatch = Extract<OrchestrationV2Command, { readonly type: "message.dispatch" }>;

/**
 * A message the user sends to a project's Inbox gets a digest of what changed since their
 * previous one, kept on the message so every reader sees what the agent saw. A message sent
 * while a run is under way (steered or queued) gets none. Only the server writes the record: one
 * a client sent is dropped. Any failure sends the message without a digest.
 */
export const attachInboxAgentDigest = Effect.fn("InboxAgent.attachDigest")(function* (
  command: MessageDispatch,
) {
  // Every message comes through here: only an Inbox message reads anything.
  if (!isInboxThread(command.threadId)) return command;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const inbox = yield* threads.getThreadShell(command.threadId).pipe(
    Effect.orElseSucceed(() => null),
    Effect.catchDefect(() => Effect.succeed(null)),
  );
  if (inbox === null) return command;
  const stripped = withoutDigestRecord(command.context);
  const plain: MessageDispatch =
    stripped === command.context
      ? command
      : (({ context: _context, ...rest }) =>
          stripped === undefined ? rest : { ...rest, context: stripped })(command);
  if (
    command.dispatchMode.type === "steer_active" ||
    command.dispatchMode.type === "restart_active" ||
    command.dispatchMode.type === "queue_after_active" ||
    inbox.activeRunId !== null
  ) {
    return plain;
  }
  const untilMs = DateTime.toEpochMillis(yield* DateTime.now);
  return yield* threads.getShellSnapshot({ projectId: inbox.projectId }).pipe(
    Effect.map((snapshot) => {
      const digest = inboxAgentDigest({
        shells: snapshot.threads,
        projectId: inbox.projectId,
        inboxThreadId: inbox.id,
        sinceMs: inboxAgentDigestSinceMs(inbox, untilMs),
        untilMs,
        messages: linearInboxLog(),
      });
      const context = withInboxAgentDigestRecord(plain.context, digest);
      return context === undefined ? plain : { ...plain, context };
    }),
    Effect.tapError((cause) => Effect.logWarning("The Inbox digest could not be built.", cause)),
    Effect.orElseSucceed(() => plain),
    Effect.catchDefect(() => Effect.succeed(plain)),
  );
});

/** The text the provider gets for an Inbox message: its digest first, when it has one. */
export function inboxAgentProviderText(
  text: string,
  message: { readonly context?: OrchestrationMessageContext | undefined },
  thread: Pick<OrchestrationV2AppThread, "id">,
): string {
  return isInboxThread(thread.id)
    ? withInboxAgentDigest(text, inboxAgentDigestOf(message.context))
    : text;
}
