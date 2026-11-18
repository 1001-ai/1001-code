import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { InboxIcon } from "lucide-react";

import { useInboxAgent } from "../../state/inboxAgent";
import { type CommandPaletteActionItem, ITEM_ICON_CLASS } from "../CommandPalette.logic";

/** The command palette's way to the Inbox of the project on screen. */
export function useInboxPaletteAction(
  environmentId: EnvironmentId | null,
  projectId: ProjectId | null,
): CommandPaletteActionItem | null {
  const inbox = useInboxAgent(
    environmentId === null || projectId === null ? null : { environmentId, projectId },
  );
  if (environmentId === null || projectId === null) return null;
  return {
    kind: "action",
    value: "action:open-inbox",
    searchTerms: ["inbox", "project", "threads", "summary", "what changed"],
    title: "Open Inbox",
    disabled: inbox.threadId === null,
    ...(inbox.unavailableReason === null ? {} : { description: inbox.unavailableReason }),
    icon: <InboxIcon className={ITEM_ICON_CLASS} />,
    run: inbox.open,
  };
}
