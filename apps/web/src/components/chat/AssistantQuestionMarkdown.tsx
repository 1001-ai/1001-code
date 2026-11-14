import type { ComponentProps } from "react";

import ChatMarkdown from "../ChatMarkdown";
import { QuestionAskedInItemContext } from "./questionBlockScope";

/** An assistant message's markdown, whose questions can be answered in the composer. */
export function AssistantQuestionMarkdown({
  askedInItemId,
  ...props
}: ComponentProps<typeof ChatMarkdown> & { readonly askedInItemId: string | undefined }) {
  return (
    <QuestionAskedInItemContext value={askedInItemId ?? null}>
      <ChatMarkdown {...props} />
    </QuestionAskedInItemContext>
  );
}
