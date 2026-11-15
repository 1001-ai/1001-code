import type { ReactNode, RefObject } from "react";

import { useComposerDraftStore, type ComposerThreadTarget } from "~/composerDraftStore";
import { useStableCallback } from "~/hooks/useStableCallback";
import type { ChatComposerHandle } from "./ChatComposer";
import { WorkspaceMutationIdContext } from "./ChatMarkdownMedia";
import { writeAnswerLine } from "./questionBlock.logic";
import { QuestionAnswerSendContext } from "./questionBlockScope";

/**
 * Lets question cards in `children` send their answer through the composer's own submit. It also
 * provides the workspace mutation id, so ChatView swaps one wrapper instead of reindenting its
 * timeline.
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
  // A draft id is a local draft thread, which has no cards, or a queued message being edited,
  // which the submit would save instead.
  const value = canSend && typeof draftTarget !== "string" ? send : null;
  return (
    <WorkspaceMutationIdContext value={workspaceMutationId}>
      <QuestionAnswerSendContext value={value}>{children}</QuestionAnswerSendContext>
    </WorkspaceMutationIdContext>
  );
}
