import { BellIcon } from "lucide-react";

import {
  ADDON_ICON_CLASS,
  type CommandPaletteSubmenuItem,
  ITEM_ICON_CLASS,
} from "../CommandPalette.logic";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { useOpenTeammateMessage, useUnreadTeammateMessages } from "./teammateMessages.state";

/** The command palette's way to the unread teammate messages; null while there are none. */
export function useTeammateMessagesPaletteItem(): CommandPaletteSubmenuItem | null {
  const messages = useUnreadTeammateMessages();
  const openMessage = useOpenTeammateMessage();
  if (messages.length === 0) return null;
  return {
    kind: "submenu",
    value: "action:teammate-messages",
    searchTerms: ["teammate", "messages", "linear", "comments", "notifications", "bell", "unread"],
    title: `Teammate messages (${messages.length})`,
    icon: <BellIcon className={ITEM_ICON_CLASS} />,
    addonIcon: <BellIcon className={ADDON_ICON_CLASS} />,
    groups: [
      {
        value: "teammate-messages",
        label: "Unread",
        items: messages.map((message) => ({
          kind: "action",
          value: `teammate-message:${message.nonce}`,
          searchTerms: [message.sender, message.issue, message.preview],
          title: `${message.sender} on ${message.issue}`,
          description: message.preview,
          timestamp: formatRelativeTimeLabel(message.at),
          icon: <BellIcon className={ITEM_ICON_CLASS} />,
          run: () => openMessage(message),
        })),
      },
    ],
  };
}
