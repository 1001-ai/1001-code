import { isQuestionDismissalMessage, questionDismissalIds } from "@t3tools/shared/questionCards";
import { XIcon } from "lucide-react";

import type { ChatMessage } from "~/types";
import { TimelineSystemDivider } from "./TimelineSystemDivider";

/**
 * A message of only `Qn: dismissed` lines, recorded without a run, reads as one muted line
 * instead of a bubble; null for any other message.
 */
export function questionDismissalRow(message: ChatMessage) {
  if (!isQuestionDismissalMessage(message)) return null;
  return (
    <TimelineSystemDivider
      label={`Dismissed ${questionDismissalIds(message.text).join(", ")}`}
      icon={XIcon}
    />
  );
}
