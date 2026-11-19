import {
  type ContextMenuItem,
  type EnvironmentId,
  isInboxThreadShell,
  type ProjectId,
  type ScopedThreadRef,
  type ThreadContextRecord,
  type ThreadId,
} from "@t3tools/contracts";
import { threadContextRecord } from "@t3tools/shared/composerContextReferences";

import { findInboxThread, type InboxShell } from "../../state/inboxAgent.logic";

export const MESSAGE_FROM_INBOX_ITEM_ID = "message-from-inbox";
export const MIXED_PROJECTS_HINT = "Select threads from one project";
export const INBOX_NOT_READY_HINT = "Inbox not ready yet";

interface SelectedThread {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly id: ThreadId;
  readonly title: string;
}

export type MessageFromInboxPlan =
  | {
      readonly inbox: ScopedThreadRef;
      /** The chips the Inbox's composer gets, as a drag into it would add them. */
      readonly recipients: ReadonlyArray<ThreadContextRecord>;
    }
  | { readonly inbox: null; readonly disabledReason: string };

/**
 * Where "Message from Inbox…" sends a sidebar selection: the Inbox of the one project the
 * selected threads share. An Inbox in the selection is never its own recipient.
 */
export function planMessageFromInbox(
  selected: ReadonlyArray<SelectedThread>,
  environmentThreads: (environmentId: EnvironmentId) => ReadonlyArray<InboxShell>,
): MessageFromInboxPlan | null {
  const inboxIdsByEnvironment = new Map<EnvironmentId, ReadonlySet<ThreadId>>();
  const inboxIds = (environmentId: EnvironmentId) => {
    let ids = inboxIdsByEnvironment.get(environmentId);
    if (ids === undefined) {
      ids = new Set(
        environmentThreads(environmentId)
          .filter(isInboxThreadShell)
          .map((thread) => thread.id),
      );
      inboxIdsByEnvironment.set(environmentId, ids);
    }
    return ids;
  };
  const threads = selected.filter((thread) => !inboxIds(thread.environmentId).has(thread.id));
  const first = threads[0];
  if (first === undefined) return null;
  if (
    threads.some(
      (thread) =>
        thread.environmentId !== first.environmentId || thread.projectId !== first.projectId,
    )
  ) {
    return { inbox: null, disabledReason: MIXED_PROJECTS_HINT };
  }
  const inbox = findInboxThread(environmentThreads(first.environmentId), first.projectId);
  if (inbox === null) return { inbox: null, disabledReason: INBOX_NOT_READY_HINT };
  return {
    inbox: { environmentId: first.environmentId, threadId: inbox.id },
    recipients: threads.map((thread) =>
      threadContextRecord(
        { environmentId: thread.environmentId, threadId: thread.id },
        thread.title,
      ),
    ),
  };
}

/** The selection menu with "Message from Inbox…" first and a separator after it. */
export function withMessageFromInboxItem<Id extends string>(
  plan: MessageFromInboxPlan | null,
  items: ReadonlyArray<ContextMenuItem<Id>>,
): Array<ContextMenuItem<Id | typeof MESSAGE_FROM_INBOX_ITEM_ID>> {
  if (plan === null) return [...items];
  const [next, ...rest] = items;
  return [
    {
      id: MESSAGE_FROM_INBOX_ITEM_ID,
      label: "Message from Inbox…",
      ...(plan.inbox === null ? { disabled: true, detail: plan.disabledReason } : {}),
    },
    ...(next === undefined ? [] : [{ ...next, separatorBefore: true }, ...rest]),
  ];
}
