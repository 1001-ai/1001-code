import type { ReactNode, RefObject } from "react";

import { useComposerDraftStore, type ComposerThreadTarget } from "~/composerDraftStore";
import { useStableCallback } from "~/hooks/useStableCallback";
import type { ChatComposerHandle } from "./ChatComposer";
import { WorkspaceMutationIdContext } from "./ChatMarkdownMedia";
import { writeAnswerLine } from "./questionBlock.logic";
import { QuestionAnswerSendContext, TimelineMessageSendContext } from "./questionBlockScope";
import { appendMessageToDraft } from "./subagentModelSwitch.logic";

/**
 * Lets question cards and timeline controls in `children` send messages through the composer's own
 * submit. It also provides the workspace mutation id, so ChatView swaps one wrapper instead of
 * reindenting its timeline.
 */
export function QuestionAnswerSendScope({
  draftTarget,
  promptRef,
  composerRef,
  canSend,
  workspaceMutationId,
  children,
}: {
  readonly draftTarget: ComposerThreadTarget;
  readonly promptRef: { current: string };
  readonly composerRef: RefObject<ChatComposerHandle | null>;
  /** False while a send would answer something else, such as an open approval or question. */
  readonly canSend: boolean;
  readonly workspaceMutationId: string | null | undefined;
  readonly children: ReactNode;
}) {
  const send = useStableCallback((questionId: string, answer: string) => {
    const store = useComposerDraftStore.getState();
    const prompt = store.getComposerDraft(draftTarget)?.prompt ?? "";
    const next = writeAnswerLine(prompt, questionId, answer);
    // Submit reads the prompt ref, which the composer syncs from the draft only after a render.
    promptRef.current = next;
    store.setPrompt(draftTarget, next);
    return composerRef.current?.submit() ?? false;
  });
  const sendMessage = useStableCallback((text: string) => {
    const store = useComposerDraftStore.getState();
    const prompt = store.getComposerDraft(draftTarget)?.prompt ?? "";
    const next = appendMessageToDraft(prompt, text);
    promptRef.current = next;
    store.setPrompt(draftTarget, next);
    return composerRef.current?.submit() ?? false;
  });
  // A draft id is a local draft thread, which has no cards, or a queued message being edited,
  // which the submit would save instead.
  const canSubmit = canSend && typeof draftTarget !== "string";
  const value = canSubmit ? send : null;
  const messageValue = canSubmit ? sendMessage : null;
  return (
    <WorkspaceMutationIdContext value={workspaceMutationId}>
      <QuestionAnswerSendContext value={value}>
        <TimelineMessageSendContext value={messageValue}>{children}</TimelineMessageSendContext>
      </QuestionAnswerSendContext>
    </WorkspaceMutationIdContext>
  );
}
