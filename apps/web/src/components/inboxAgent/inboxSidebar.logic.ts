import type { InboxAgentStatus } from "../../state/inboxAgent.logic";

/** The Projects section lists the picked projects, or every pickable one when none is picked. */
export function inboxSidebarProjects<Group>(
  scopedGroups: readonly Group[],
  pickableGroups: readonly Group[],
): readonly Group[] {
  return scopedGroups.length > 0 ? scopedGroups : pickableGroups;
}

/** A closed folder hides its Inbox row, as it hides threads, unless the Inbox is open. */
export function inboxFolderRowVisible(input: {
  readonly collapsed: boolean;
  readonly isRoute: boolean;
}): boolean {
  return !input.collapsed || input.isRoute;
}

/** An idle Inbox shows no dot, so only one that is running or needs the user stands out. */
export const INBOX_STATUS_DOT: Record<
  InboxAgentStatus,
  { readonly className: string; readonly label: string } | null
> = {
  running: { className: "bg-info", label: "Working" },
  waiting: { className: "bg-warning", label: "Needs you" },
  idle: null,
};
