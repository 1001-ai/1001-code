import type { ComponentProps } from "react";

import { BoardIssueRefScope, useBoardIssueRefs } from "../board/boardIssueLinks";
import ChatMarkdown from "../ChatMarkdown";
import { BackReferenceScope, useBackReferences } from "./BackReferenceLink";
import { QuestionAskedInItemContext } from "./questionBlockScope";
import { QuestionRefScope, useQuestionRefs } from "./QuestionRefLink";

/** An assistant message's markdown, whose questions render as cards the user answers in place. */
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
  const backReferences = useBackReferences({
    threadRef: props.threadRef,
    itemId: askedInItemId,
    text: props.text,
    streaming: props.isStreaming === true,
    markdownProps: questionRefs.markdownProps,
  });
  const issueRefs = useBoardIssueRefs({
    threadRef: props.threadRef,
    text: props.text,
    streaming: props.isStreaming === true,
    markdownProps: backReferences.markdownProps,
  });
  return (
    <QuestionAskedInItemContext value={askedInItemId ?? null}>
      <QuestionRefScope value={questionRefs.scope}>
        <BackReferenceScope value={backReferences.scope}>
          <BoardIssueRefScope value={issueRefs.scope}>
            <ChatMarkdown {...props} {...issueRefs.markdownProps} />
          </BoardIssueRefScope>
        </BackReferenceScope>
      </QuestionRefScope>
    </QuestionAskedInItemContext>
  );
}
