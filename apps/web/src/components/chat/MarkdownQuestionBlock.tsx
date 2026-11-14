import { parseScopedThreadKey, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import { CheckIcon } from "lucide-react";
import { use, useId, useState, type FormEvent, type ReactNode } from "react";

import { useComposerDraftStore } from "~/composerDraftStore";
import { environmentThreadDetails } from "../../state/threads";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Toggle } from "../ui/toggle";
import {
  findQuestionAnswer,
  parseQuestionBlock,
  questionOptions,
  readAnswerLine,
  selectedMultiOptions,
  toggleMultiOption,
  writeAnswerLine,
  type QuestionBlock,
} from "./questionBlock.logic";
import { QuestionAskedInItemContext } from "./questionBlockScope";

const questionAnswerAtomFamily = Atom.family((key: string) => {
  const [thread = "", askedInItemId = "", questionId = ""] = key.split("\u0000");
  const threadRef = parseScopedThreadKey(thread);
  return Atom.make((get) =>
    threadRef === null
      ? null
      : findQuestionAnswer(
          get(environmentThreadDetails.quietVisibleTurnItemsAtom(threadRef)),
          askedInItemId,
          questionId,
        ),
  ).pipe(Atom.setIdleTTL(0));
});

/**
 * A `question` fence in an assistant message. Answering writes `<id>: answer` into the thread's
 * draft and never sends; the card reads as answered once a later user message carries that line.
 */
export function MarkdownQuestionBlock({
  code,
  threadRef,
  streaming,
  children,
}: {
  readonly code: string;
  readonly threadRef: ScopedThreadRef;
  readonly streaming: boolean;
  /** The ordinary code block, shown when the fence is not a valid question. */
  readonly children: ReactNode;
}) {
  const askedInItemId = use(QuestionAskedInItemContext);
  if (askedInItemId === null) return children;
  if (streaming) {
    return (
      <div
        role="status"
        className="my-[0.65rem] rounded-xl border border-border/70 bg-card/60 px-3 py-2.5 text-muted-foreground text-sm"
      >
        Writing a question…
      </div>
    );
  }
  const question = parseQuestionBlock(code);
  if (question === null) return children;
  return <QuestionCard question={question} threadRef={threadRef} askedInItemId={askedInItemId} />;
}

function QuestionCard({
  question,
  threadRef,
  askedInItemId,
}: {
  readonly question: QuestionBlock;
  readonly threadRef: ScopedThreadRef;
  readonly askedInItemId: string;
}) {
  const promptId = useId();
  const [changing, setChanging] = useState(false);
  const [freeText, setFreeText] = useState("");
  const answer = useAtomValue(
    questionAnswerAtomFamily(
      `${scopedThreadKey(threadRef)}\u0000${askedInItemId}\u0000${question.id}`,
    ),
  );
  const draftAnswer = useComposerDraftStore((store) => {
    const prompt = store.getComposerDraft(threadRef)?.prompt;
    return prompt ? readAnswerLine(prompt, question.id) : null;
  });
  const writeDraftAnswer = (next: string | null) => {
    const store = useComposerDraftStore.getState();
    const prompt = store.getComposerDraft(threadRef)?.prompt ?? "";
    store.setPrompt(threadRef, writeAnswerLine(prompt, question.id, next));
  };
  const submitFreeText = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (freeText.trim().length === 0) return;
    writeDraftAnswer(freeText);
    setFreeText("");
  };

  const options = questionOptions(question);
  const selectedMulti =
    question.kind === "multi" ? selectedMultiOptions(options, draftAnswer) : new Set<string>();
  const showControls = answer === null || changing;

  return (
    <section
      aria-labelledby={promptId}
      data-chat-markdown-question={question.id}
      className="my-[0.65rem] flex w-full min-w-0 flex-col gap-2 rounded-xl border border-border/70 bg-card/60 px-3 py-2.5"
    >
      <div className="flex min-w-0 items-baseline gap-2">
        <Badge variant="outline" size="sm">
          {question.id}
        </Badge>
        <p id={promptId} className="min-w-0 font-medium text-sm [overflow-wrap:anywhere]">
          {question.prompt}
        </p>
      </div>
      {answer !== null ? (
        <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
          <CheckIcon aria-hidden className="size-3.5 text-success-foreground" />
          <span className="min-w-0 [overflow-wrap:anywhere]">
            <span className="text-muted-foreground">Answered: </span>
            {answer}
          </span>
          {changing ? null : (
            <Button type="button" variant="ghost-muted" size="xs" onClick={() => setChanging(true)}>
              Change answer
            </Button>
          )}
        </div>
      ) : null}
      {showControls ? (
        <>
          {options.length > 0 ? (
            <div
              role="group"
              aria-label={question.kind === "multi" ? "Choose any that apply" : "Choose one"}
              className="flex flex-wrap gap-1.5"
            >
              {options.map((option) => (
                <Toggle
                  key={option}
                  variant="outline"
                  size="sm"
                  pressed={
                    question.kind === "multi" ? selectedMulti.has(option) : draftAnswer === option
                  }
                  onPressedChange={(pressed) =>
                    writeDraftAnswer(
                      question.kind === "multi"
                        ? toggleMultiOption(options, draftAnswer, option)
                        : pressed
                          ? option
                          : null,
                    )
                  }
                >
                  {option}
                  {option === question.recommended ? (
                    <Badge variant="info" size="sm">
                      Recommended
                    </Badge>
                  ) : null}
                </Toggle>
              ))}
            </div>
          ) : null}
          <form className="flex min-w-0 items-center gap-1.5" onSubmit={submitFreeText}>
            <Input
              size="sm"
              value={freeText}
              maxLength={500}
              onChange={(event) => setFreeText(event.target.value)}
              placeholder={
                question.kind === "text" ? "Type your answer" : "Or answer in your own words"
              }
              aria-label={`Answer ${question.id} in your own words`}
            />
            <Button type="submit" variant="outline" size="sm" disabled={freeText.trim() === ""}>
              Add to draft
            </Button>
          </form>
          {draftAnswer !== null ? (
            <div className="flex min-w-0 flex-wrap items-center gap-2 text-muted-foreground text-xs">
              <span className="min-w-0 [overflow-wrap:anywhere]">In your draft: {draftAnswer}</span>
              <Button
                type="button"
                variant="ghost-muted"
                size="xs"
                onClick={() => writeDraftAnswer(null)}
              >
                Remove
              </Button>
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
