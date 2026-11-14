import { parseScopedThreadKey, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import { CheckIcon, PencilLineIcon } from "lucide-react";
import {
  use,
  useId,
  useRef,
  type ComponentProps,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import { useComposerDraftStore } from "~/composerDraftStore";
import { cn } from "~/lib/utils";
import { environmentThreadDetails } from "../../state/threads";
import {
  findQuestionAnswer,
  parseQuestionBlock,
  questionOptions,
  readAnswerLine,
  selectedMultiOptions,
  toggleMultiOption,
  writeAnswerLine,
  type QuestionAnswer,
  type QuestionBlock,
} from "./questionBlock.logic";
import { QuestionAskedInItemContext } from "./questionBlockScope";

const questionAnswerAtomFamily = Atom.family((key: string) => {
  const [thread = "", askedInItemId = "", questionId = ""] = key.split("\u0000");
  const threadRef = parseScopedThreadKey(thread);
  let previous: QuestionAnswer | null = null;
  return Atom.make((get) => {
    const next =
      threadRef === null
        ? null
        : findQuestionAnswer(
            get(environmentThreadDetails.timelineVisibleTurnItemsAtom(threadRef)),
            askedInItemId,
            questionId,
          );
    if (next?.messageId !== previous?.messageId || next?.answer !== previous?.answer) {
      previous = next;
    }
    return previous;
  }).pipe(Atom.setIdleTTL(0));
});

// Kept alive so typing and an open "Change answer" survive the card remounting when streaming ends.
const questionFreeTextAtomFamily = Atom.family((key: string) =>
  Atom.make("").pipe(Atom.keepAlive, Atom.withLabel(`question-free-text:${key}`)),
);
const questionChangingFromAtomFamily = Atom.family((key: string) =>
  Atom.make<string | null>(null).pipe(
    Atom.keepAlive,
    Atom.withLabel(`question-changing-from:${key}`),
  ),
);

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
        className="my-4 rounded-xl border border-border/70 bg-muted/30 px-4 py-3 text-muted-foreground text-sm"
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
  const freeTextHintId = useId();
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const cardKey = `${scopedThreadKey(threadRef)}\u0000${askedInItemId}\u0000${question.id}`;
  // The message whose answer is being changed, so a newer answering message closes the controls.
  const changingFrom = useAtomValue(questionChangingFromAtomFamily(cardKey));
  const setChangingFrom = useAtomSet(questionChangingFromAtomFamily(cardKey));
  const freeText = useAtomValue(questionFreeTextAtomFamily(cardKey));
  const setFreeText = useAtomSet(questionFreeTextAtomFamily(cardKey));
  const answer = useAtomValue(questionAnswerAtomFamily(cardKey));
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
  const multi = question.kind === "multi";
  const selectedMulti = multi ? selectedMultiOptions(options, draftAnswer) : new Set<string>();
  const isSelected = (option: string) =>
    multi ? selectedMulti.has(option) : draftAnswer === option;
  const choose = (option: string) =>
    writeDraftAnswer(multi ? toggleMultiOption(options, draftAnswer, option) : option);
  // A radio group is one tab stop, on the checked option or else the first.
  const radioTabStop = Math.max(options.indexOf(draftAnswer ?? ""), 0);
  const moveFocus = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const last = options.length - 1;
    const next =
      event.key === "ArrowDown" || event.key === "ArrowRight"
        ? index === last
          ? 0
          : index + 1
        : event.key === "ArrowUp" || event.key === "ArrowLeft"
          ? index === 0
            ? last
            : index - 1
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? last
              : null;
    if (next === null) return;
    event.preventDefault();
    optionRefs.current[next]?.focus();
    if (!multi) writeDraftAnswer(options[next] ?? null);
  };
  const changing = answer !== null && changingFrom === answer.messageId;
  const showControls = answer === null || changing;

  return (
    <section
      aria-labelledby={promptId}
      data-chat-markdown-question={question.id}
      className="my-4 flex w-full min-w-0 flex-col gap-1 rounded-xl border border-border/70 bg-muted/30 px-4 py-3"
    >
      <div className="min-w-0 text-sm [overflow-wrap:anywhere]">
        <span className="me-2 font-mono text-2xs text-muted-foreground">{question.id}</span>
        <span id={promptId} className="font-medium">
          {question.prompt}
        </span>
      </div>
      {answer !== null ? (
        <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-muted-foreground text-sm">
          <CheckIcon aria-hidden className="size-3.5 shrink-0 text-success-foreground" />
          <span className="min-w-0 [overflow-wrap:anywhere]">
            Answered: <span className="text-foreground">{answer.answer}</span>
          </span>
          {changing ? null : (
            <>
              <span aria-hidden>·</span>
              <QuietAction
                aria-label={`Change your answer to ${question.id}`}
                onClick={() => setChangingFrom(answer.messageId)}
              >
                Change
              </QuietAction>
            </>
          )}
        </div>
      ) : null}
      {showControls ? (
        <>
          {options.length > 0 ? (
            <div
              role={multi ? "group" : "radiogroup"}
              aria-labelledby={promptId}
              className="flex min-w-0 flex-col"
            >
              {options.map((option, index) => {
                const selected = isSelected(option);
                return (
                  <button
                    key={option}
                    ref={(element) => {
                      optionRefs.current[index] = element;
                    }}
                    type="button"
                    role={multi ? "checkbox" : "radio"}
                    aria-checked={selected}
                    tabIndex={multi || index === radioTabStop ? 0 : -1}
                    onClick={() => choose(option)}
                    onKeyDown={(event) => moveFocus(event, index)}
                    className={cn(
                      "-mx-2 flex min-w-0 items-start gap-2.5 rounded-md px-2 py-1 text-start text-sm outline-none hover:bg-accent/60 focus-visible:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-inset",
                      selected ? "font-medium text-foreground" : "text-foreground/80",
                    )}
                  >
                    <OptionMarker multi={multi} selected={selected} />
                    <span className="min-w-0 [overflow-wrap:anywhere]">
                      {option}
                      {option === question.recommended ? (
                        <span className="ms-2 font-normal text-muted-foreground text-xs">
                          recommended
                        </span>
                      ) : null}
                    </span>
                  </button>
                );
              })}
            </div>
          ) : null}
          <form
            className="-mx-2 flex min-w-0 items-center gap-2.5 rounded-md px-2 py-1 hover:bg-accent/60 has-focus-visible:bg-accent/60"
            onSubmit={submitFreeText}
          >
            <span aria-hidden className="flex w-3.5 shrink-0 justify-center">
              <PencilLineIcon className="size-3.5 text-muted-foreground/70" />
            </span>
            <input
              value={freeText}
              maxLength={500}
              enterKeyHint="done"
              onChange={(event) => setFreeText(event.target.value)}
              placeholder={question.kind === "text" ? "Type an answer…" : "Or type an answer…"}
              aria-label={`Answer ${question.id} in your own words`}
              aria-describedby={freeTextHintId}
              className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground/70"
            />
            <span id={freeTextHintId} className="sr-only">
              Press Enter to add it to your draft.
            </span>
            {freeText.trim() === "" ? null : (
              <span aria-hidden className="shrink-0 text-muted-foreground text-xs">
                Enter to add
              </span>
            )}
          </form>
          {draftAnswer !== null ? (
            <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-muted-foreground text-xs">
              <span className="min-w-0 [overflow-wrap:anywhere]">In your draft: {draftAnswer}</span>
              <span aria-hidden>·</span>
              <QuietAction
                aria-label={`Remove ${question.id} from your draft`}
                onClick={() => writeDraftAnswer(null)}
              >
                Remove
              </QuietAction>
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

function OptionMarker({
  multi,
  selected,
}: {
  readonly multi: boolean;
  readonly selected: boolean;
}) {
  return (
    <span aria-hidden className="flex h-5 w-3.5 shrink-0 items-center justify-center">
      {multi ? (
        selected ? (
          <CheckIcon strokeWidth={3} className="size-3.5 text-primary" />
        ) : (
          <span className="size-3 rounded-xs border border-foreground/25" />
        )
      ) : (
        <span
          className={cn(
            "flex size-3 items-center justify-center rounded-full border",
            selected ? "border-primary" : "border-foreground/25",
          )}
        >
          {selected ? <span className="size-1.5 rounded-full bg-primary" /> : null}
        </span>
      )}
    </span>
  );
}

function QuietAction(props: Omit<ComponentProps<"button">, "type" | "className">) {
  return (
    <button
      type="button"
      className="rounded-sm text-muted-foreground underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:text-foreground focus-visible:underline"
      {...props}
    />
  );
}
