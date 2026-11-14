import type { ComponentProps } from "react";

import ChatMarkdown from "../ChatMarkdown";
import { QuestionAskedInItemContext } from "./questionBlockScope";
import { QuestionRefScope, useQuestionRefs } from "./QuestionRefLink";

/** An assistant message's markdown, whose questions can be answered in the composer. */
export function AssistantQuestionMarkdown({
  askedInItemId,
  ...props
}: ComponentProps<typeof ChatMarkdown> & { readonly askedInItemId: string | undefined }) {
  const questionRefs = useQuestionRefs({
    threadRef: props.threadRef,
    askedInItemId,
    text: props.text,
    streaming: props.isStreaming === true,
  });
  return (
    <QuestionAskedInItemContext value={askedInItemId ?? null}>
      <QuestionRefScope value={questionRefs.scope}>
        <ChatMarkdown {...props} {...questionRefs.markdownProps} />
      </QuestionRefScope>
    </QuestionAskedInItemContext>
  );
}
