import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  type AssistantCitation,
  AuthOrchestrationOperateScope,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import { useRef, useState } from "react";

import { useComposerDraftStore } from "~/composerDraftStore";
import { isElectron } from "~/env";
import {
  assistantCitationNavigation,
  assistantCitationRoute,
} from "~/lib/assistantCitationNavigation";
import { newMessageId } from "~/lib/utils";
import { useEnvironmentScope } from "~/state/session";
import { environmentThreadDetails, threadEnvironment } from "~/state/threads";
import { useOrchestrationCommand } from "~/state/use-orchestration-command";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import { DEFAULT_INTERACTION_MODE } from "~/types";
import { BackgroundThreadContext } from "../chat/backgroundThread";
import type { ChatComposerHandle } from "../chat/ChatComposer";
import { ComposerBanner } from "../chat/ComposerBanner";
import { ComposerPendingUserInputPanel } from "../chat/ComposerPendingUserInputPanel";
import { QuestionCard } from "../chat/MarkdownQuestionBlock";
import { usePendingThreadRequests } from "../chat/usePendingThreadRequests";
import { useEnvironmentLookups, useProjectLookups } from "../CommandPaletteLookups";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { SidebarInset } from "../ui/sidebar";
import { Spinner } from "../ui/spinner";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { QuestionsApproval } from "./QuestionsApproval";
import {
  matchesFilter,
  questionAnswersMessage,
  waitingSummary,
  withoutSentAnswerLines,
  type OpenQuestionCard,
  type WaitingSummary,
} from "./questionsPage.logic";
import {
  questionsThreadEntriesAtom,
  waitingSince,
  type QuestionsThreadEntry,
} from "./questionsPage.state";

type QuestionsFilter = "all" | "questions" | "approvals";

const FILTERS: ReadonlyArray<{ readonly value: QuestionsFilter; readonly label: string }> = [
  { value: "all", label: "All" },
  { value: "questions", label: "Questions" },
  { value: "approvals", label: "Approvals" },
];

function pluralize(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

export function QuestionsPage() {
  const entries = useAtomValue(questionsThreadEntriesAtom);
  const [filter, setFilter] = useState<QuestionsFilter>("all");
  const { environmentLabelById } = useEnvironmentLookups();
  const { projectByKey } = useProjectLookups();
  const summarized = entries.map((entry) => ({ entry, summary: waitingSummary(entry) }));
  const waiting = summarized.reduce((total, { summary }) => total + summary.count, 0);
  const shown = summarized.filter(({ entry, summary }) =>
    matchesFilter(summary, entry.loaded, filter),
  );

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        <WorkspacePageHeader electron={isElectron} className="border-b border-border">
          <h1 className="truncate font-medium text-sm">Questions</h1>
          <Badge variant="secondary">{waiting} waiting</Badge>
          <div className="min-w-0 flex-1" />
          <ToggleGroup
            aria-label="Show"
            className="[-webkit-app-region:no-drag]"
            value={[filter]}
            onValueChange={(next) => {
              const value = FILTERS.find((option) => option.value === next[0])?.value;
              if (value !== undefined) setFilter(value);
            }}
          >
            {FILTERS.map((option) => (
              <Toggle key={option.value} value={option.value}>
                {option.label}
              </Toggle>
            ))}
          </ToggleGroup>
        </WorkspacePageHeader>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {entries.length === 0 ? (
            <Empty className="h-full">
              <EmptyHeader>
                <EmptyTitle>Nothing is waiting on you</EmptyTitle>
                <EmptyDescription>
                  Questions and approvals from agents in every thread show up here.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : shown.length === 0 ? (
            <Empty className="h-full">
              <EmptyHeader>
                <EmptyTitle>
                  {filter === "questions" ? "No questions waiting" : "No approvals waiting"}
                </EmptyTitle>
                <EmptyDescription>
                  {pluralize(waiting, "item waits", "items wait")} under All.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            // Every thread here is in the background: no panel may take the page's shortcuts.
            <BackgroundThreadContext value>
              <WorkspacePageContainer width="readable" className="gap-4">
                {shown.map(({ entry, summary }) => (
                  <QuestionsThreadGroup
                    key={`${entry.ref.environmentId}:${entry.ref.threadId}`}
                    entry={entry}
                    summary={summary}
                    filter={filter}
                    projectTitle={
                      projectByKey.get(`${entry.ref.environmentId}:${entry.shell.projectId}`)
                        ?.title ?? null
                    }
                    environmentLabel={environmentLabelById.get(entry.ref.environmentId) ?? null}
                  />
                ))}
              </WorkspacePageContainer>
            </BackgroundThreadContext>
          )}
        </div>
      </div>
    </SidebarInset>
  );
}

function QuestionsThreadGroup({
  entry,
  summary,
  filter,
  projectTitle,
  environmentLabel,
}: {
  readonly entry: QuestionsThreadEntry;
  readonly summary: WaitingSummary;
  readonly filter: QuestionsFilter;
  readonly projectTitle: string | null;
  readonly environmentLabel: string | null;
}) {
  const { ref, shell, cards, requests } = entry;
  const { questions, approvals } = summary;
  const showQuestions = filter !== "approvals";
  const showApprovals = filter !== "questions";
  const meta = [projectTitle, environmentLabel, formatRelativeTimeLabel(waitingSince(entry))]
    .filter(Boolean)
    .join(" · ");
  const unshown =
    (showQuestions && summary.unshownQuestion) || (showApprovals && summary.unshownApproval);

  return (
    <section
      aria-label={shell.title}
      className="overflow-hidden rounded-xl border border-border bg-card"
    >
      <header className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-border px-4 py-2.5">
        <h2 className="min-w-0 truncate font-semibold text-sm">{shell.title}</h2>
        {meta ? (
          <span className="min-w-0 truncate text-muted-foreground text-xs">{meta}</span>
        ) : null}
        <div className="min-w-0 flex-1" />
        {questions > 0 ? (
          <Badge variant="info">{pluralize(questions, "question", "questions")}</Badge>
        ) : null}
        {approvals > 0 ? (
          <Badge variant="warning">
            {approvals === 1 ? "Approval" : pluralize(approvals, "approval", "approvals")}
          </Badge>
        ) : null}
        <OpenThreadLink threadRef={ref} entry={entry} />
      </header>
      <div className="flex flex-col divide-y divide-border">
        {!entry.loaded ? (
          <div className="flex items-center gap-2 px-4 py-3 text-muted-foreground text-sm">
            <Spinner className="size-3.5" />
            Loading…
          </div>
        ) : null}
        {unshown ? (
          <p className="px-4 py-3 text-muted-foreground text-sm">
            {showQuestions && summary.unshownQuestion && shell.openQuestionsAt
              ? "The agent's questions are not in the loaded part of this thread. Open the thread to answer them."
              : "The agent is waiting on you here. Open the thread to respond."}
          </p>
        ) : null}
        {showQuestions
          ? cards.map((card) => (
              <QuestionCard
                key={`${card.askedInItemId}:${card.question.id}`}
                question={card.question}
                threadRef={ref}
                askedInItemId={card.askedInItemId}
                embedded
              />
            ))
          : null}
        {showQuestions && requests.userInputs.length > 0 ? (
          <QuestionsUserInput threadRef={ref} />
        ) : null}
        {showApprovals
          ? requests.approvals.map((approval) => (
              <QuestionsApproval key={approval.requestId} threadRef={ref} approval={approval} />
            ))
          : null}
      </div>
      {showQuestions && cards.length > 0 ? (
        <QuestionsSendFooter threadRef={ref} entry={entry} cards={cards} />
      ) : null}
    </section>
  );
}

/** Opens the thread at its first open card, the way a question id link does. */
function OpenThreadLink({
  threadRef,
  entry,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly entry: QuestionsThreadEntry;
}) {
  const navigate = useNavigate();
  const card = entry.cards[0];
  const citation: AssistantCitation | null =
    card === undefined
      ? null
      : {
          version: 1,
          environmentId: threadRef.environmentId,
          threadId: threadRef.threadId,
          messageId: card.messageId,
          text: card.question.prompt,
          start: 0,
          end: card.question.prompt.length,
          prefix: card.question.id,
          suffix: "",
        };
  // The href carries the citation too, so a new tab or modified click lands on the card.
  const route =
    citation === null
      ? { to: "/$environmentId/$threadId" as const, params: threadRef }
      : assistantCitationRoute(citation, entry.shell);
  return (
    <Link
      {...route}
      aria-label={`Open ${entry.shell.title}`}
      className="shrink-0 text-muted-foreground text-xs underline underline-offset-2 hover:text-foreground"
      onClick={(event) => {
        if (
          citation === null ||
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        ) {
          return;
        }
        event.preventDefault();
        void navigate(assistantCitationNavigation(citation, entry.shell));
      }}
    >
      Open thread
    </Link>
  );
}

/**
 * Answers go into the thread's draft, as the card does in the thread, so either place shows them.
 * Sending posts only their `<id>: answer` lines and leaves the rest of the draft alone.
 */
function QuestionsSendFooter({
  threadRef,
  entry,
  cards,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly entry: QuestionsThreadEntry;
  readonly cards: ReadonlyArray<OpenQuestionCard>;
}) {
  const canOperate = useEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope);
  const startTurn = useOrchestrationCommand(threadEnvironment.startTurn, { reportFailure: false });
  const [sending, setSending] = useState(false);
  // The cards stay listed until the shell sees the reply; Send waits for them to go.
  const [sentFor, setSentFor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const draftPrompt = useComposerDraftStore(
    (store) => store.getComposerDraft(threadRef)?.prompt ?? "",
  );
  const questionIds = cards.map((card) => card.question.id);
  const cardsKey = cards.map((card) => `${card.askedInItemId}:${card.question.id}`).join("\n");
  const sent = sentFor === cardsKey;
  const message = questionAnswersMessage(draftPrompt, questionIds);

  const send = async () => {
    if (message === null || sending || sent) return;
    setSending(true);
    setError(null);
    const result = await startTurn({
      environmentId: threadRef.environmentId,
      input: {
        threadId: threadRef.threadId,
        message: { messageId: newMessageId(), role: "user", text: message.text, attachments: [] },
        runtimeMode: entry.shell.runtimeMode,
        interactionMode: DEFAULT_INTERACTION_MODE,
        // The server starts it, or steers or queues it into a running turn, as it can.
        dispatchMode: "auto",
      },
    });
    if (result._tag === "Success") {
      const store = useComposerDraftStore.getState();
      const prompt = store.getComposerDraft(threadRef)?.prompt ?? "";
      store.setPrompt(threadRef, withoutSentAnswerLines(prompt, message.answers));
      setSentFor(cardsKey);
    } else if (!isAtomCommandInterrupted(result)) {
      const failure = squashAtomCommandFailure(result);
      setError(failure instanceof Error ? failure.message : "Could not send the answers.");
    }
    setSending(false);
  };

  return (
    <footer className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 border-t border-border bg-muted/40 px-4 py-2.5">
      <p className="min-w-0 flex-1 text-muted-foreground text-xs [overflow-wrap:anywhere]">
        {sent ? (
          "Answers sent"
        ) : message === null ? (
          "No answer yet"
        ) : (
          <>
            Will send:{" "}
            {message.answers.map((answer, index) => (
              <span key={answer.id}>
                {index > 0 ? " · " : null}
                <span className="font-medium text-foreground">
                  {answer.id}: {answer.answer}
                </span>
              </span>
            ))}
          </>
        )}
        {error !== null ? (
          <span role="alert" className="block text-destructive">
            {error}
          </span>
        ) : null}
      </p>
      <Button
        size="sm"
        variant={message === null ? "outline" : "default"}
        disabled={message === null || sending || sent || !canOperate}
        onClick={() => void send()}
      >
        {sending ? "Sending…" : sent ? "Sent" : "Send answers"}
      </Button>
    </footer>
  );
}

/** The provider's own questions, answered through the same hook and panel as the composer's. */
function QuestionsUserInput({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const canOperate = useEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope);
  const structure = useAtomValue(environmentThreadDetails.quietThreadAtom(threadRef));
  const promptRef = useRef("");
  const composerRef = useRef<ChatComposerHandle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const requests = usePendingThreadRequests({
    environmentId: threadRef.environmentId,
    activeThreadId: threadRef.threadId,
    serverProjection: structure?.projection ?? null,
    supportsQuestionAttachments: false,
    composerDraftTarget: threadRef,
    setComposerDraftPrompt: (target, prompt) =>
      useComposerDraftStore.getState().setPrompt(target, prompt),
    promptRef,
    composerRef,
    setThreadError: (_threadId, message) => setError(message),
  });
  if (requests.pendingUserInputs.length === 0) return null;
  const activeQuestion = requests.activePendingProgress?.activeQuestion;
  return (
    <div className="flex flex-col gap-1.5 px-4 py-3">
      <ComposerBanner.Root variant="info">
        <ComposerPendingUserInputPanel
          pendingUserInputs={requests.pendingUserInputs}
          cwd={undefined}
          threadRef={threadRef}
          disabled={!canOperate}
          respondingRequestIds={
            requests.activePendingIsResponding && requests.activePendingUserInput
              ? [...requests.respondingRequestIds, requests.activePendingUserInput.requestId]
              : requests.respondingRequestIds
          }
          answers={requests.activePendingDraftAnswers}
          questionIndex={requests.activePendingQuestionIndex}
          onToggleOption={requests.onSelectActivePendingUserInputOption}
          onAdvance={requests.onAdvanceActivePendingUserInput}
          onDismiss={requests.onDismissUserInput}
        />
      </ComposerBanner.Root>
      {activeQuestion !== undefined &&
      activeQuestion !== null &&
      activeQuestion.options.length === 0 ? (
        <p className="text-muted-foreground text-xs">
          This question takes a typed answer. Open the thread to write it.
        </p>
      ) : null}
      {error !== null ? (
        <p role="alert" className="text-destructive text-xs">
          {error}
        </p>
      ) : null}
    </div>
  );
}
