import { parseScopedThreadKey, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import { CheckIcon, CircleSlashIcon, PencilLineIcon } from "lucide-react";
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
import {
  parseQuestionQuote,
  QUESTION_SKIPPED_ANSWER,
  type QuestionBlock,
} from "@t3tools/shared/questionCards";
import { environmentThreadDetails } from "../../state/threads";
import {
  findQuestionAnswer,
  isQuestionWithdrawn,
  questionOptions,
  readAnswerLine,
  selectedMultiOptions,
  toggleMultiOption,
  writeAnswerLine,
  type QuestionAnswer,
} from "./questionBlock.logic";
import { QuestionAnswerSendContext, QuestionAskedInItemContext } from "./questionBlockScope";
import { Button } from "../ui/button";

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
            // A queued answer is not a turn item until its run dispatches.
            get(environmentThreadDetails.queueWorkflowAtom(threadRef))?.queuedRuns,
          );
    if (next?.messageId !== previous?.messageId || next?.answer !== previous?.answer) {
      previous = next;
    }
    return previous;
  }).pipe(Atom.setIdleTTL(0));
});

const questionWithdrawnAtomFamily = Atom.family((key: string) => {
  const [thread = "", askedInItemId = "", questionId = ""] = key.split("\u0000");
  const threadRef = parseScopedThreadKey(thread);
  return Atom.make(
    (get) =>
      threadRef !== null &&
      isQuestionWithdrawn(
        get(environmentThreadDetails.timelineVisibleTurnItemsAtom(threadRef)),
        askedInItemId,
        questionId,
      ),
  ).pipe(Atom.setIdleTTL(0));
});

// Kept alive so typing, an open "Change answer" and a send in flight survive the card remounting when streaming ends.
const questionFreeTextAtomFamily = Atom.family((key: string) =>
  Atom.make("").pipe(Atom.keepAlive, Atom.withLabel(`question-free-text:${key}`)),
);
const questionChangingFromAtomFamily = Atom.family((key: string) =>
  Atom.make<string | null>(null).pipe(
    Atom.keepAlive,
    Atom.withLabel(`question-changing-from:${key}`),
  ),
);
// What the card sent, shown until a failed send puts it back in the draft or an answer newer
// than `after` arrives.
const questionSentAtomFamily = Atom.family((key: string) =>
  Atom.make<{ answer: string; after: string | null } | null>(null).pipe(
    Atom.keepAlive,
    Atom.withLabel(`question-sent:${key}`),
  ),
);

/**
 * A blockquote in an assistant message, shown as a question card when its source is one. Answering
 * sends `<id>: answer` with the rest of the thread's draft, or only writes it into the draft where
 * the card cannot send. The card reads as answered once a later user message carries that line.
 * While the message streams, the quote shows as written.
 */
export function MarkdownQuestionQuote({
  source,
  threadRef,
  streaming,
  children,
}: {
  readonly source: string;
  readonly threadRef: ScopedThreadRef;
  readonly streaming: boolean;
  /** The ordinary blockquote. */
  readonly children: ReactNode;
}) {
  const askedInItemId = use(QuestionAskedInItemContext);
  if (askedInItemId === null || streaming) return children;
  const question = parseQuestionQuote(source);
  if (question === null) return children;
  return <QuestionCard question={question} threadRef={threadRef} askedInItemId={askedInItemId} />;
}

export function QuestionCard({
  question,
  threadRef,
  askedInItemId,
  embedded = false,
}: {
  readonly question: QuestionBlock;
  readonly threadRef: ScopedThreadRef;
  readonly askedInItemId: string;
  /** A row inside a box that already draws the border, as on the Questions page. */
  readonly embedded?: boolean;
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
  const withdrawn = useAtomValue(questionWithdrawnAtomFamily(cardKey));
  const sendAnswer = use(QuestionAnswerSendContext);
  const sent = useAtomValue(questionSentAtomFamily(cardKey));
  const setSent = useAtomSet(questionSentAtomFamily(cardKey));
  const draftAnswer = useComposerDraftStore((store) => {
    const prompt = store.getComposerDraft(threadRef)?.prompt;
    return prompt ? readAnswerLine(prompt, question.id) : null;
  });
  const writeDraftAnswer = (next: string | null) => {
    setSent(null);
    const store = useComposerDraftStore.getState();
    const prompt = store.getComposerDraft(threadRef)?.prompt ?? "";
    store.setPrompt(threadRef, writeAnswerLine(prompt, question.id, next));
  };
  const send = (next: string) => {
    if (sendAnswer?.(question.id, next)) {
      setSent({ answer: next.trim(), after: answer?.messageId ?? null });
    }
  };
  const submitFreeText = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (freeText.trim().length === 0) return;
    if (sendAnswer === null) writeDraftAnswer(freeText);
    else send(freeText);
    setFreeText("");
  };

  const changing = answer !== null && changingFrom === answer.messageId;
  const options = questionOptions(question);
  const multi = question.kind === "multi";
  const selectedMulti = multi ? selectedMultiOptions(options, draftAnswer) : new Set<string>();
  const isSelected = (option: string) =>
    multi ? selectedMulti.has(option) : draftAnswer === option;
  // A single choice that sends on click is a group of actions, not a radio group.
  const radio = !multi && sendAnswer === null;
  const choose = (option: string) => {
    if (multi) writeDraftAnswer(toggleMultiOption(options, draftAnswer, option));
    else if (sendAnswer === null) writeDraftAnswer(option);
    else send(option);
  };
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
    if (radio) writeDraftAnswer(options[next] ?? null);
  };
  const skipped = draftAnswer === QUESTION_SKIPPED_ANSWER;
  // Skip is one more single choice: it sends where the card can, and a second click undoes it.
  const skip = () => {
    if (skipped) writeDraftAnswer(null);
    else if (sendAnswer === null) writeDraftAnswer(QUESTION_SKIPPED_ANSWER);
    else send(QUESTION_SKIPPED_ANSWER);
  };
  const sendingAnswer =
    sent !== null && draftAnswer === null && sent.after === (answer?.messageId ?? null)
      ? sent.answer
      : null;
  // An answer the user gives, or one on its way, still wins over the agent's withdrawal.
  const showWithdrawn = answer === null && withdrawn && sendingAnswer === null;
  const showControls = (answer === null && !showWithdrawn) || changing;

  return (
    <section
      aria-labelledby={promptId}
      data-chat-markdown-question={question.id}
      className={cn(
        "flex w-full min-w-0 flex-col gap-1 px-4 py-3",
        !embedded && "my-4 rounded-xl border border-border/70 bg-card",
      )}
    >
      <div className="flex min-w-0 items-start gap-2">
        <div className="min-w-0 flex-1 text-sm [overflow-wrap:anywhere]">
          <span className="me-2 font-mono text-2xs text-muted-foreground">{question.id}</span>
          <span id={promptId} className="font-medium">
            {question.prompt}
          </span>
        </div>
        {showControls && sendingAnswer === null ? (
          <Button
            size="micro"
            variant="ghost-muted"
            aria-label={`Skip ${question.id}`}
            aria-pressed={skipped}
            data-pressed={skipped ? "" : undefined}
            onClick={skip}
          >
            Skip
          </Button>
        ) : null}
      </div>
      {showWithdrawn ? (
        <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-muted-foreground text-sm">
          <CircleSlashIcon aria-hidden className="size-3.5 shrink-0" />
          <span className="min-w-0 [overflow-wrap:anywhere]">No longer needed</span>
          <span aria-hidden>·</span>
          <span>withdrawn by the agent</span>
        </div>
      ) : null}
      {answer !== null ? (
        <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-muted-foreground text-sm">
          <CheckIcon aria-hidden className="size-3.5 shrink-0 text-success-foreground" />
          <span className="min-w-0 [overflow-wrap:anywhere]">
            {answer.answer === QUESTION_SKIPPED_ANSWER ? (
              "Skipped"
            ) : (
              <>
                Answered: <span className="text-foreground">{answer.answer}</span>
              </>
            )}
          </span>
          {/* Change and Cancel wait for an in-flight send; neither could stop it. */}
          {sendingAnswer !== null ? null : <span aria-hidden>·</span>}
          {sendingAnswer === null && changing ? (
            <QuietAction
              aria-label={`Keep your answer to ${question.id}`}
              onClick={() => {
                setChangingFrom(null);
                writeDraftAnswer(null);
              }}
            >
              Cancel
            </QuietAction>
          ) : sendingAnswer === null ? (
            <QuietAction
              aria-label={`Change your answer to ${question.id}`}
              onClick={() => {
                setChangingFrom(answer.messageId);
                setSent(null);
                // Selections live in the draft, so they start from the current answer.
                if ((multi || sendAnswer === null) && draftAnswer === null) {
                  writeDraftAnswer(answer.answer);
                }
              }}
            >
              Change
            </QuietAction>
          ) : null}
        </div>
      ) : null}
      {sendingAnswer !== null ? (
        // A send that never lands (a discarded queued message) must not lock the card.
        <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-muted-foreground text-sm">
          <span className="min-w-0 [overflow-wrap:anywhere]">Sending: {sendingAnswer}</span>
          <span aria-hidden>·</span>
          <QuietAction aria-label={`Answer ${question.id} again`} onClick={() => setSent(null)}>
            Answer again
          </QuietAction>
        </div>
      ) : showControls ? (
        <>
          {options.length > 0 ? (
            <div
              role={radio ? "radiogroup" : "group"}
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
                    role={multi ? "checkbox" : radio ? "radio" : undefined}
                    aria-checked={multi || radio ? selected : undefined}
                    tabIndex={!radio || index === radioTabStop ? 0 : -1}
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
          {multi && sendAnswer !== null && draftAnswer !== null && selectedMulti.size > 0 ? (
            <div className="flex py-1">
              <Button
                size="xs"
                aria-label={`Send your answer to ${question.id}`}
                onClick={() => send(draftAnswer)}
              >
                Send
              </Button>
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
              enterKeyHint={sendAnswer === null ? "done" : "send"}
              onChange={(event) => setFreeText(event.target.value)}
              placeholder={question.kind === "text" ? "Type an answer…" : "Or type an answer…"}
              aria-label={`Answer ${question.id} in your own words`}
              aria-describedby={freeTextHintId}
              className="min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-muted-foreground/70 sm:text-sm"
            />
            <span id={freeTextHintId} className="sr-only">
              {sendAnswer === null
                ? "Press Enter to add it to your draft."
                : "Press Enter to send it."}
            </span>
            {freeText.trim() === "" ? null : (
              <span aria-hidden className="shrink-0 text-muted-foreground text-xs">
                {sendAnswer === null ? "Enter to add" : "Enter to send"}
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
