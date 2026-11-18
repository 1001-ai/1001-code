import {
  type MessageId,
  PROJECT_MOMENT_SNIPPET_MAX_LENGTH,
  PROJECT_MOMENTS_LIMIT,
  type ProjectMoment,
  type ProjectMomentSender,
  type ThreadId,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import { questionCardsInMarkdown } from "@t3tools/shared/questionCards";
import { resolveT3McpToolId } from "@t3tools/shared/t3McpToolPresentation";

/** The thread fields that decide whether a thread's moments show and how they are labelled. */
export interface MomentThread {
  readonly threadId: ThreadId;
  readonly title: string;
  readonly relationshipToParent: string | null;
  readonly sideChat: boolean;
  readonly voiceAgent: boolean;
  readonly delegated: boolean;
}

/** Subagents, side chats and the voice agent's hidden thread work for another thread. */
export function isMomentThread(thread: MomentThread): boolean {
  return (
    thread.relationshipToParent !== "subagent" &&
    !thread.delegated &&
    !thread.sideChat &&
    !thread.voiceAgent
  );
}

export interface MomentMessage {
  readonly id: MessageId;
  readonly threadId: ThreadId;
  readonly role: string;
  readonly streaming: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly text: string;
  readonly createdBy: string | null;
  readonly scheduledTaskId: string | null;
  readonly senderThreadId: ThreadId | null;
  readonly linkedSenderTitle: string | null;
  /** Set when the message is T3 Code's own `/compact`, a delegated completion or a workflow script. */
  readonly internal: boolean;
  /** Set on wakes: a background task, command, monitor or pull request reporting in. */
  readonly notification: boolean;
  /** Set when this is the thread's earliest user-role message. */
  readonly opensThread: boolean;
}

function momentSnippet(text: string): string {
  const flat = text.replaceAll(/\s+/g, " ").trim();
  return flat.length <= PROJECT_MOMENT_SNIPPET_MAX_LENGTH
    ? flat
    : `${flat.slice(0, PROJECT_MOMENT_SNIPPET_MAX_LENGTH - 1)}…`;
}

/** Who sent a user-role message, or null when it is not one a person would call a prompt. */
function classifyPromptSender(
  message: Pick<
    MomentMessage,
    | "createdBy"
    | "scheduledTaskId"
    | "senderThreadId"
    | "linkedSenderTitle"
    | "internal"
    | "notification"
  >,
  senderThreadTitle: string | null,
): ProjectMomentSender | null {
  if (message.internal || message.notification) return null;
  if (message.linkedSenderTitle !== null) {
    return { kind: "linked-agent", title: message.linkedSenderTitle };
  }
  if (message.senderThreadId !== null) return { kind: "agent", title: senderThreadTitle };
  if (message.scheduledTaskId !== null) return { kind: "scheduled-task", title: null };
  if (message.createdBy === "user") return { kind: "user", title: null };
  return null;
}

export function messageMoment(
  message: MomentMessage,
  threadTitle: string,
  senderThreadTitle: string | null,
): ProjectMoment | null {
  if (message.role === "user") {
    const sender = classifyPromptSender(message, senderThreadTitle);
    if (sender === null) return null;
    const kind =
      sender.kind === "agent" || sender.kind === "linked-agent" ? "agent-in" : "thread-started";
    if (kind === "thread-started" && !message.opensThread) return null;
    return {
      id: `${kind}:${message.id}`,
      kind,
      threadId: message.threadId,
      threadTitle,
      at: message.createdAt,
      messageId: message.id,
      snippet: momentSnippet(message.text),
      sender,
    };
  }
  if (message.role !== "assistant" || message.streaming) return null;
  const [first] = questionCardsInMarkdown(message.text);
  if (first === undefined) return null;
  return {
    id: `question:${message.id}`,
    kind: "question",
    threadId: message.threadId,
    threadTitle,
    // Cards exist once the message finishes.
    at: message.updatedAt,
    messageId: message.id,
    snippet: momentSnippet(first.prompt),
  };
}

export interface MomentRuntimeRequest {
  readonly id: string;
  readonly threadId: ThreadId;
  readonly kind: string;
  readonly status: string;
  readonly createdAt: string;
}

export const runtimeRequestMomentId = (requestId: string) => `input:${requestId}`;

/** Only provider questions still waiting count; approvals are not questions. */
export function runtimeRequestMoment(
  request: MomentRuntimeRequest,
  threadTitle: string,
): ProjectMoment | null {
  if (request.kind !== "user_input" || request.status !== "pending") return null;
  return {
    id: runtimeRequestMomentId(request.id),
    kind: "input-request",
    threadId: request.threadId,
    threadTitle,
    at: request.createdAt,
    messageId: null,
    snippet: "",
  };
}

const BACKGROUND_WAKE_SOURCE_KINDS = new Set([
  "background_task",
  "background_command",
  "command",
  "monitor",
]);

export interface MomentRun {
  readonly runId: string;
  readonly threadId: ThreadId;
  readonly status: string;
  readonly completedAt: string | null;
  readonly prompt: {
    readonly notificationSourceKind: string | null;
    readonly notificationSourceWork: string | null;
    readonly notificationOutcome: string | null;
    readonly delegatedCompletion: boolean;
    readonly idleCompaction: boolean;
  } | null;
  /** A person steered a message into the run, which makes a wake theirs. */
  readonly userSteered: boolean;
  readonly lastAssistant: { readonly id: MessageId; readonly text: string } | null;
}

/** Mirrors the shell's background-wake rule: progress wakes nobody asked for are not "done". */
function isBackgroundWakeRun(run: Pick<MomentRun, "prompt" | "userSteered">): boolean {
  const prompt = run.prompt;
  return (
    prompt !== null &&
    !prompt.delegatedCompletion &&
    prompt.notificationOutcome === "updated" &&
    prompt.notificationSourceKind !== null &&
    BACKGROUND_WAKE_SOURCE_KINDS.has(prompt.notificationSourceKind) &&
    prompt.notificationSourceWork === null &&
    !run.userSteered
  );
}

export function runMoment(run: MomentRun, threadTitle: string): ProjectMoment | null {
  if (run.status !== "completed" || run.completedAt === null) return null;
  if (run.prompt?.idleCompaction === true || isBackgroundWakeRun(run)) return null;
  return {
    id: `done:${run.runId}`,
    kind: "done",
    threadId: run.threadId,
    threadTitle,
    at: run.completedAt,
    messageId: run.lastAssistant?.id ?? null,
    snippet: momentSnippet(run.lastAssistant?.text ?? ""),
  };
}

export interface MomentToolItem {
  readonly id: string;
  readonly threadId: ThreadId;
  readonly type: string;
  readonly status: string;
  readonly toolName: string | null;
  readonly input: unknown;
  readonly updatedAt: string;
}

function stringField(input: unknown, key: string): string | null {
  if (typeof input !== "object" || input === null) return null;
  const value = (input as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/** The linked environment a finished `t3_thread_send` went to, or null for this one. */
function outgoingAgentEnvironment(
  item: MomentToolItem,
  ownEnvironmentId: string | null,
): string | null {
  if (item.type !== "dynamic_tool" || item.status !== "completed") return null;
  if (resolveT3McpToolId(item.toolName) !== "t3_thread_send") return null;
  const environmentId = stringField(item.input, "environmentId");
  return environmentId === null || environmentId === ownEnvironmentId ? null : environmentId;
}

export function toolItemMoment(
  item: MomentToolItem,
  threadTitle: string,
  ownEnvironmentId: string | null,
  environmentLabel: (environmentId: string) => string | null,
): ProjectMoment | null {
  const environmentId = outgoingAgentEnvironment(item, ownEnvironmentId);
  if (environmentId === null) return null;
  return {
    id: `agent-out:${item.id}`,
    kind: "agent-out",
    threadId: item.threadId,
    threadTitle,
    at: item.updatedAt,
    messageId: null,
    snippet: momentSnippet(stringField(item.input, "message") ?? ""),
    sender: { kind: "linked-agent", title: environmentLabel(environmentId) },
  };
}

const pullRequestKey = (link: Pick<ThreadPullRequestLink, "host" | "repository" | "number">) =>
  `${link.host}/${link.repository}#${link.number}`;

/**
 * A thread's pull request moments: merged at its merge time, and in testing while it is open
 * with checks pending. The testing id names the pull request, so settled checks remove it.
 */
export function pullRequestMoments(
  threadId: ThreadId,
  threadTitle: string,
  links: ReadonlyArray<ThreadPullRequestLink>,
): ReadonlyArray<ProjectMoment> {
  const moments: ProjectMoment[] = [];
  for (const link of links) {
    if (link.source === "stack-dismissed" || link.snapshot === null) continue;
    const pullRequest = { number: link.number, url: link.url, title: link.snapshot.title };
    const key = pullRequestKey(link);
    if (link.snapshot.state === "merged" && link.snapshot.mergedAt) {
      moments.push({
        id: `pr-merged:${threadId}:${key}`,
        kind: "pr-merged",
        threadId,
        threadTitle,
        at: link.snapshot.mergedAt,
        messageId: null,
        snippet: momentSnippet(link.snapshot.title),
        pullRequest,
      });
    } else if (link.snapshot.state === "open" && link.snapshot.checksState === "pending") {
      moments.push({
        id: `pr-testing:${threadId}:${key}`,
        kind: "pr-testing",
        threadId,
        threadTitle,
        at: link.snapshot.updatedAt ?? link.linkedAt,
        messageId: null,
        snippet: momentSnippet(link.snapshot.title),
        pullRequest,
      });
    }
  }
  return moments;
}

/** The ids a thread's previous pull request moments had that its new ones lack. */
export function removedPullRequestMomentIds(
  previous: ReadonlySet<string>,
  next: ReadonlyArray<ProjectMoment>,
): ReadonlyArray<string> {
  const kept = new Set(next.map((moment) => moment.id));
  return [...previous].filter((id) => !kept.has(id));
}

function compareMoments(left: ProjectMoment, right: ProjectMoment): number {
  const byTime = Date.parse(left.at) - Date.parse(right.at);
  if (byTime !== 0 && Number.isFinite(byTime)) return byTime;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

/** The newest moments at or after `since`, oldest first, within the limit. */
export function windowMoments(
  moments: Iterable<ProjectMoment>,
  sinceMillis: number,
  limit = PROJECT_MOMENTS_LIMIT,
): { readonly moments: ReadonlyArray<ProjectMoment>; readonly truncated: boolean } {
  const byId = new Map<string, ProjectMoment>();
  for (const moment of moments) {
    if (Date.parse(moment.at) >= sinceMillis) byId.set(moment.id, moment);
  }
  const sorted = [...byId.values()].toSorted(compareMoments);
  return sorted.length > limit
    ? { moments: sorted.slice(sorted.length - limit), truncated: true }
    : { moments: sorted, truncated: false };
}

const SENT_MEMORY = 2_000;

/**
 * Remembers the last moment sent for each id, so a stream of identical updates (a message
 * streaming, a run touched again) sends each moment once.
 */
export function makeSentMoments() {
  const sent = new Map<string, { readonly threadId: ThreadId; readonly encoded: string }>();
  return {
    /** True when this moment differs from the one last sent under its id. */
    changed(moment: ProjectMoment): boolean {
      const encoded = JSON.stringify(moment);
      if (sent.get(moment.id)?.encoded === encoded) return false;
      sent.delete(moment.id);
      sent.set(moment.id, { threadId: moment.threadId, encoded });
      if (sent.size > SENT_MEMORY) sent.delete(sent.keys().next().value as string);
      return true;
    },
    forget(id: string): void {
      sent.delete(id);
    },
    /** The thread's sent moments under a new title, for sending again. */
    retitled(threadId: ThreadId, threadTitle: string): ReadonlyArray<ProjectMoment> {
      const moments: ProjectMoment[] = [];
      for (const entry of sent.values()) {
        if (entry.threadId !== threadId) continue;
        const moment = JSON.parse(entry.encoded) as ProjectMoment;
        if (moment.threadTitle !== threadTitle) moments.push({ ...moment, threadTitle });
      }
      return moments;
    },
    forgetThread(threadId: ThreadId): void {
      for (const [id, entry] of sent) {
        if (entry.threadId === threadId) sent.delete(id);
      }
    },
  };
}
