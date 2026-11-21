import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { InboxIcon, RotateCcwIcon } from "lucide-react";

import { useProject } from "../../state/entities";
import { useInboxAgent, useResetInbox } from "../../state/inboxAgent";
import { type CommandPaletteActionItem, ITEM_ICON_CLASS } from "../CommandPalette.logic";

/** The command palette's actions for the Inbox of the project on screen. */
export function useInboxPaletteActions(
  environmentId: EnvironmentId | null,
  projectId: ProjectId | null,
): ReadonlyArray<CommandPaletteActionItem> {
  const ref = environmentId === null || projectId === null ? null : { environmentId, projectId };
  const project = useProject(ref);
  const inbox = useInboxAgent(ref);
  const resetInbox = useResetInbox(ref, {
    projectDisplayName: project?.title,
    threadId: inbox.threadId,
  });
  if (ref === null) return [];
  return [
    {
      kind: "action",
      value: "action:open-inbox",
      searchTerms: ["inbox", "project", "threads", "summary", "what changed"],
      title: "Open Inbox",
      disabled: inbox.threadId === null,
      ...(inbox.unavailableReason === null ? {} : { description: inbox.unavailableReason }),
      icon: <InboxIcon className={ITEM_ICON_CLASS} />,
      run: inbox.open,
    },
    {
      kind: "action",
      value: "action:reset-inbox",
      searchTerms: ["reset", "inbox", "new", "clear", "restart", "start over", "project"],
      title: "Reset Inbox",
      disabled: inbox.threadId === null || !resetInbox.canReset,
      ...(inbox.unavailableReason === null ? {} : { description: inbox.unavailableReason }),
      icon: <RotateCcwIcon className={ITEM_ICON_CLASS} />,
      run: async () => {
        await resetInbox.reset();
      },
    },
  ];
}
