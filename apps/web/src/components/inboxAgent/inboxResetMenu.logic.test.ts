import { ThreadId, type ContextMenuItem } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  INBOX_RESET_MENU_ITEM_ID,
  inboxResetConfirmMessage,
  withInboxResetMenuItem,
} from "./inboxResetMenu.logic";

const INBOX_THREAD = {
  source: {
    title: "Inbox",
    createdBy: "system" as const,
    creationSource: "server" as const,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: ThreadId.make("i") },
  },
};

const ORDINARY_THREAD = {
  source: {
    title: "Fix bug",
    createdBy: "user" as const,
    creationSource: "web" as const,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: ThreadId.make("t") },
  },
};

const BASE_ITEMS: ReadonlyArray<ContextMenuItem<"copy" | "archive" | "delete">> = [
  { id: "copy", label: "Copy" },
  { id: "archive", label: "Archive thread", separatorBefore: true },
  { id: "delete", label: "Delete", destructive: true },
];

describe("inboxResetMenu.logic", () => {
  it("leaves ordinary thread menus unchanged and inserts Reset Inbox before archive for Inbox threads", () => {
    expect(withInboxResetMenuItem(ORDINARY_THREAD, true, BASE_ITEMS)).toEqual(BASE_ITEMS);

    const inboxItems = withInboxResetMenuItem(INBOX_THREAD, true, BASE_ITEMS);
    expect(inboxItems.map((item) => item.id)).toEqual([
      "copy",
      INBOX_RESET_MENU_ITEM_ID,
      "archive",
      "delete",
    ]);
    expect(inboxItems[1]).toMatchObject({
      id: INBOX_RESET_MENU_ITEM_ID,
      label: "Reset Inbox",
      icon: "refresh-cw",
      separatorBefore: true,
    });
    expect(inboxItems[1]?.disabled).toBeUndefined();

    const readOnly = withInboxResetMenuItem(INBOX_THREAD, false, BASE_ITEMS);
    expect(readOnly[1]?.disabled).toBe(true);
  });

  it("includes the project name in the confirmation message when provided", () => {
    expect(inboxResetConfirmMessage("Acme")).toContain('Reset Inbox for "Acme"?');
    expect(inboxResetConfirmMessage(null)).toContain("Reset Inbox?");
  });
});
