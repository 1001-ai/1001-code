import type { ContextMenuItem } from "@t3tools/contracts";

import { isInboxClientThread } from "../../state/inboxAgent.logic";

export const INBOX_RESET_MENU_ITEM_ID = "inbox:reset";

export function inboxResetConfirmMessage(projectDisplayName?: string | null): string {
  const label = projectDisplayName ? `Inbox for "${projectDisplayName}"` : "Inbox";
  return [
    `Reset ${label}?`,
    "This deletes the current Inbox thread and starts over with a new one.",
  ].join("\n");
}

/**
 * Adds "Reset Inbox" to the thread action menu when the thread is a project's Inbox.
 * Ordinary threads keep their menu unchanged.
 */
export function withInboxResetMenuItem<Id extends string>(
  thread: Parameters<typeof isInboxClientThread>[0],
  canOperate: boolean,
  items: ReadonlyArray<ContextMenuItem<Id>>,
): Array<ContextMenuItem<Id | typeof INBOX_RESET_MENU_ITEM_ID>> {
  if (!isInboxClientThread(thread)) return [...items];
  const resetItem: ContextMenuItem<typeof INBOX_RESET_MENU_ITEM_ID> = {
    id: INBOX_RESET_MENU_ITEM_ID,
    label: "Reset Inbox",
    icon: "refresh-cw",
    separatorBefore: true,
    ...(!canOperate ? { disabled: true } : {}),
  };
  const archiveIndex = items.findIndex((item) => item.id === "archive");
  if (archiveIndex === -1) return [...items, resetItem];
  return [...items.slice(0, archiveIndex), resetItem, ...items.slice(archiveIndex)];
}
