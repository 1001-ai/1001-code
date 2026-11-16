import { useAtomValue } from "@effect/atom-react";
import { MessageCircleQuestionMarkIcon } from "lucide-react";

import { type CommandPaletteActionItem, ITEM_ICON_CLASS } from "../CommandPalette.logic";
import { hasWaitingQuestionsAtom } from "./questionsPage.state";

/** The sidebar footer's Questions label, which the button's tooltip and screen readers read. */
export function useQuestionsButtonLabel(): string {
  return useAtomValue(hasWaitingQuestionsAtom) ? "Questions, waiting" : "Questions";
}

/** The sidebar footer's Questions icon, dotted while any thread waits on the user. */
export function QuestionsButtonIcon() {
  const waiting = useAtomValue(hasWaitingQuestionsAtom);
  // Drawn inside the svg: a wrapper span would be the menu button's last child, which it truncates.
  return (
    <MessageCircleQuestionMarkIcon aria-hidden="true" className="overflow-visible">
      {waiting ? (
        <circle
          cx="22.5"
          cy="1.5"
          r="6"
          strokeWidth="3"
          className="fill-warning stroke-sidebar in-[[data-slot=sidebar-menu-button]:hover]:stroke-sidebar-row-hover"
        />
      ) : null}
    </MessageCircleQuestionMarkIcon>
  );
}

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
