import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthSourceControlWriteScope,
  type EnvironmentId,
  MEMORY_PROPOSAL_MAX_LENGTH,
  type MemoryChoice,
  type MemoryProposal,
  type OrchestrationV2TurnItem,
  type ProjectId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { CheckIcon } from "lucide-react";
import { useState } from "react";

import { useOpenLink } from "~/browser/useOpenLink";
import { useThreadShell } from "~/state/entities";
import { memoryDecide, useMemory } from "~/state/memory";
import { useEnvironmentScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { memoryProposalInput, proposalForCall } from "./memoryProposal.logic";

/** Accept for me, Accept for team, Reject: one person's click, from this client's session. */
export function useMemoryDecision(environmentId: EnvironmentId, projectId: ProjectId | null) {
  const decide = useAtomCommand(memoryDecide, { reportFailure: false });
  const canDecide = useEnvironmentScope(environmentId, AuthSourceControlWriteScope);
  const [busy, setBusy] = useState<MemoryChoice | null>(null);
  const [error, setError] = useState<string | null>(null);
  const submit = async (proposal: MemoryProposal, choice: MemoryChoice, text: string) => {
    if (projectId === null) return;
    setBusy(choice);
    setError(null);
    const result = await decide({
      environmentId,
      input: { projectId, proposalId: proposal.id, choice, text: text.trim() || proposal.text },
    });
    setBusy(null);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const failure = squashAtomCommandFailure(result);
      setError(failure instanceof Error ? failure.message : "The memory could not be saved.");
    }
  };
  return { canDecide, busy, error, submit };
}

export function MemoryDecisionButtons(props: {
  readonly busy: MemoryChoice | null;
  readonly canDecide: boolean;
  readonly disabled?: boolean;
  readonly onChoose: (choice: MemoryChoice) => void;
}) {
  const disabled = props.busy !== null || !props.canDecide || props.disabled === true;
  return (
    <>
      <Button size="xs" variant="outline" disabled={disabled} onClick={() => props.onChoose("me")}>
        {props.busy === "me" ? "Saving…" : "Accept for me"}
      </Button>
      <Button
        size="xs"
        variant="outline"
        disabled={disabled}
        onClick={() => props.onChoose("team")}
      >
        {props.busy === "team" ? "Saving…" : "Accept for team"}
      </Button>
      <Button
        size="xs"
        variant="ghost-muted"
        disabled={disabled}
        onClick={() => props.onChoose("reject")}
      >
        Reject
      </Button>
    </>
  );
}

/** How a decided proposal ended, with its pull request when it has one. */
function MemoryOutcome(props: {
  readonly proposal: MemoryProposal;
  readonly projectName: string | null;
  readonly threadRef: ScopedThreadRef;
}) {
  const openLink = useOpenLink(props.threadRef);
  const decision = props.proposal.decision;
  if (decision === null) return null;
  if (decision.choice === "reject") {
    return <p className="text-xs text-muted-foreground">Rejected</p>;
  }
  const url = decision.pullRequestUrl;
  const link = (label: string) =>
    url === null ? (
      label
    ) : (
      <button
        type="button"
        className="underline underline-offset-2 hover:text-foreground"
        onClick={(event) => void openLink(url, { event }).catch(() => undefined)}
      >
        {label}
      </button>
    );
  const where = props.projectName === null ? "" : ` in ${props.projectName}`;
  return (
    <p className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
      <CheckIcon aria-hidden className="size-3.5 shrink-0 text-success-foreground" />
      <span>
        Accepted {decision.choice === "me" ? "for you" : "for the team"}
        {where}
      </span>
      {decision.merged ? (
        <span>· {link("merged")} · applies from the next turn</span>
      ) : (
        <span className="text-warning-foreground">
          · {link("not merged")}: {decision.problem ?? "the repository refused it"}
        </span>
      )}
    </p>
  );
}

/** The card a `memory_propose` call leaves in the chat. */
export function MemoryProposalCard(props: {
  readonly environmentId: EnvironmentId;
  readonly item: Extract<OrchestrationV2TurnItem, { type: "dynamic_tool" }>;
}) {
  const { item } = props;
  const threadRef = scopeThreadRef(props.environmentId, item.threadId);
  const projectId = useThreadShell(threadRef)?.projectId ?? null;
  const view = useMemory(props.environmentId, projectId);
  const call = memoryProposalInput(item.input);
  const proposal =
    view === null || call === null
      ? undefined
      : proposalForCall(view.proposals, {
          threadId: item.threadId,
          text: call.text,
          startedAt: DateTime.formatIso(item.startedAt ?? item.updatedAt),
        });
  const projectName = view?.documents.find((document) => document.scope === "project")?.label;
  const decision = useMemoryDecision(props.environmentId, projectId);
  const [draft, setDraft] = useState<string | null>(null);
  if (call === null) return null;

  const pending = proposal !== undefined && proposal.decision === null;
  return (
    <div
      data-v2-item-type="memory-proposal"
      className="flex min-w-0 flex-col gap-2 rounded-xl border border-border/70 bg-card px-4 py-3"
    >
      <div className="min-w-0 text-sm [overflow-wrap:anywhere]">
        <span className="me-2 font-mono text-2xs text-muted-foreground">memory</span>
        {pending ? (
          <span className="font-medium">Remember this?</span>
        ) : (
          <span
            className={
              proposal?.decision?.choice === "reject"
                ? "text-muted-foreground line-through"
                : "font-medium"
            }
          >
            {proposal?.decision?.text ?? call.text}
          </span>
        )}
      </div>
      {pending ? (
        <>
          <Textarea
            aria-label="Memory to save"
            rows={2}
            value={draft ?? proposal.text}
            maxLength={MEMORY_PROPOSAL_MAX_LENGTH}
            onChange={(event) => setDraft(event.target.value)}
          />
          {proposal.reason !== "" ? (
            <p className="text-xs text-muted-foreground">{proposal.reason}</p>
          ) : null}
          {decision.error !== null ? (
            <p role="alert" className="text-xs text-destructive">
              {decision.error}
            </p>
          ) : null}
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <MemoryDecisionButtons
              busy={decision.busy}
              canDecide={decision.canDecide}
              disabled={(draft ?? proposal.text).trim() === ""}
              onChoose={(choice) => void decision.submit(proposal, choice, draft ?? proposal.text)}
            />
            <span className="min-w-0 flex-1" />
            <span className="text-xs text-muted-foreground">
              {decision.canDecide
                ? "Applies from the next turn"
                : "This connection cannot push to the team repository."}
            </span>
          </div>
        </>
      ) : proposal !== undefined ? (
        <MemoryOutcome
          proposal={proposal}
          projectName={projectName ?? null}
          threadRef={threadRef}
        />
      ) : view !== null ? (
        <p className="text-xs text-muted-foreground">This proposal is no longer available.</p>
      ) : null}
    </div>
  );
}
