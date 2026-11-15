import { MessageCircleQuestionMarkIcon } from "lucide-react";

import { type CommandPaletteActionItem, ITEM_ICON_CLASS } from "../CommandPalette.logic";

export { MessageCircleQuestionMarkIcon as QuestionsIcon };

/** The command palette's way to the Questions page. */
export function questionsPaletteAction(open: () => Promise<void>): CommandPaletteActionItem {
  return {
    kind: "action",
    value: "action:questions",
    searchTerms: ["questions", "approvals", "waiting", "inbox", "answers", "input"],
    title: "Open questions",
    icon: <MessageCircleQuestionMarkIcon className={ITEM_ICON_CLASS} />,
    shortcutCommand: "questions.open",
    run: open,
  };
}
