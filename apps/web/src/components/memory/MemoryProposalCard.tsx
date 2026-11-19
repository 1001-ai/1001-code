import { useAtomValue } from "@effect/atom-react";
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
  type MemoryProposalKind,
  type MemoryScope,
  type OrchestrationV2TurnItem,
  type ProjectId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { CheckIcon } from "lucide-react";
import { useState } from "react";

import { useOpenLink } from "~/browser/useOpenLink";
import { cn } from "~/lib/utils";
import { useThreadShell } from "~/state/entities";
import { memoryDecide, memoryUndo, useMemory } from "~/state/memory";
import { useEnvironmentScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import {
  memoryProposalInput,
  memoryScopeLabel,
  proposalForCall,
  proposalTarget,
} from "./memoryProposal.logic";

const failureMessage = (
  result: Parameters<typeof squashAtomCommandFailure>[0],
  fallback: string,
) => {
  const failure = squashAtomCommandFailure(result);
  return failure instanceof Error ? failure.message : fallback;
};

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
      setError(failureMessage(result, "The memory could not be saved."));
    }
  };
  return { canDecide, busy, error, submit };
}

export function MemoryDecisionButtons(props: {
  readonly busy: MemoryChoice | null;
  readonly canDecide: boolean;
  /** Accepting needs a line to save; rejecting never does. */
  readonly acceptDisabled?: boolean;
  /** A voice agent memory is one person's, so it has no team choice. */
  readonly personalOnly?: boolean;
  /** A change or removal already has its file, so it has one accept. */
  readonly kind?: MemoryProposalKind | null;
  readonly onChoose: (choice: MemoryChoice) => void;
}) {
  const disabled = props.busy !== null || !props.canDecide;
  const acceptDisabled = disabled || props.acceptDisabled === true;
  const kind = props.kind ?? null;
  return (
    <>
      {kind === null ? (
        <>
          <Button
            size="xs"
            variant="outline"
            disabled={acceptDisabled}
            onClick={() => props.onChoose("me")}
          >
            {props.busy === "me" ? "Saving…" : props.personalOnly ? "Accept" : "Accept for me"}
          </Button>
          {props.personalOnly ? null : (
            <Button
              size="xs"
              variant="outline"
              disabled={acceptDisabled}
              onClick={() => props.onChoose("team")}
            >
              {props.busy === "team" ? "Saving…" : "Accept for team"}
            </Button>
          )}
        </>
      ) : (
        <Button
          size="xs"
          variant="outline"
          disabled={acceptDisabled}
          onClick={() => props.onChoose("accept")}
        >
          {props.busy === "accept"
            ? "Saving…"
            : kind === "change"
              ? "Accept change"
              : "Accept removal"}
        </Button>
      )}
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

/** The memory a voice agent proposal takes the place of, shown above or below the new line. */
export function MemoryReplaces(props: { readonly replaces: string | null }) {
  return props.replaces === null ? null : (
    <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
      Replaces: <span className="line-through">{props.replaces}</span>
    </p>
  );
}

/** "Memory change" or "Memory removal", with the scope of the file the line is in. */
export function MemoryEditHeader(props: {
  readonly kind: MemoryProposalKind;
  readonly scope: MemoryScope | null;
}) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
      <span className="font-medium">
        {props.kind === "change" ? "Memory change" : "Memory removal"}
      </span>
      {props.scope === null ? null : (
        <Badge variant="outline" size="sm">
          {memoryScopeLabel(props.scope)}
        </Badge>
      )}
    </div>
  );
}

/** The saved line struck through, and for a change the line that takes its place. */
export function MemoryEditLines(props: {
  readonly kind: MemoryProposalKind;
  readonly replaces: string;
  readonly text: string;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1 text-sm [overflow-wrap:anywhere]">
      <p className="rounded-md bg-destructive/8 px-2 py-1 text-muted-foreground dark:bg-destructive/16">
        <span aria-hidden className="me-1.5 font-mono">
          −
        </span>
        <span className="sr-only">Old: </span>
        <span className="line-through">{props.replaces}</span>
      </p>
      {props.kind === "change" ? (
        <p className="rounded-md bg-success/8 px-2 py-1 dark:bg-success/16">
          <span aria-hidden className="me-1.5 font-mono">
            +
          </span>
          <span className="sr-only">New: </span>
          {props.text}
        </p>
      ) : null}
    </div>
  );
}

/** How a decided proposal ended, with its pull request when it has one, and a way to undo it. */
function MemoryOutcome(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId | null;
  readonly proposal: MemoryProposal;
  readonly projectName: string | null;
  readonly threadRef: ScopedThreadRef;
}) {
  const openLink = useOpenLink(props.threadRef);
  const undo = useAtomCommand(memoryUndo, { reportFailure: false });
  const canUndo = useAtomValue(memoryUndo.permissionAtom(props.environmentId));
  const [undoing, setUndoing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { proposal } = props;
  const decision = proposal.decision;
  if (decision === null) return null;
  if (decision.choice === "withdrawn") {
    return (
      <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
        Withdrawn by the agent{decision.reason ? `: ${decision.reason}` : ""}
      </p>
    );
  }
  if (decision.choice === "reject") {
    return <p className="text-xs text-muted-foreground">Rejected</p>;
  }
  const link = (label: string, url: string | null) =>
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
  const accepted =
    proposal.category !== undefined
      ? "Accepted for the voice agent"
      : proposal.kind === "change"
        ? "Change accepted"
        : proposal.kind === "remove"
          ? "Removal accepted"
          : `Accepted ${decision.choice === "me" ? "for you" : "for the team"}${where}`;
  const undone = decision.undo;
  const undoable =
    proposal.category === undefined && decision.merged && undone === undefined && canUndo;
  const onUndo = async () => {
    if (props.projectId === null) return;
    setUndoing(true);
    setError(null);
    const result = await undo({
      environmentId: props.environmentId,
      input: { projectId: props.projectId, proposalId: proposal.id },
    });
    setUndoing(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      setError(failureMessage(result, "The memory could not be undone."));
    }
  };
  return (
    <>
      <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
        {undone === undefined ? (
          <>
            <CheckIcon aria-hidden className="size-3.5 shrink-0 text-success-foreground" />
            <span>{accepted}</span>
            {decision.merged ? (
              <span>· {link("merged", decision.pullRequestUrl)} · applies from the next turn</span>
            ) : (
              <span className="text-warning-foreground">
                · {link("not merged", decision.pullRequestUrl)}:{" "}
                {decision.problem ?? "the repository refused it"}
              </span>
            )}
          </>
        ) : undone.merged ? (
          <span>Undone · {link("merged", undone.pullRequestUrl)}</span>
        ) : (
          <span className="text-warning-foreground">
            Undone · {link("not merged", undone.pullRequestUrl)}:{" "}
            {undone.problem ?? "the repository refused it"}
          </span>
        )}
        {undoable ? (
          <>
            <span className="min-w-0 flex-1" />
            <Button
              size="xs"
              variant="ghost-muted"
              disabled={undoing || props.projectId === null}
              onClick={() => void onUndo()}
            >
              {undoing ? "Undoing…" : "Undo"}
            </Button>
          </>
        ) : null}
      </div>
      {error !== null ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </>
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
          voiceAgent: call.voiceAgent,
          kind: call.kind,
        });
  const projectName = view?.documents.find((document) => document.scope === "project")?.label;
  const decision = useMemoryDecision(props.environmentId, projectId);
  const [draft, setDraft] = useState<string | null>(null);
  if (call === null) return null;

  const pending = proposal !== undefined && proposal.decision === null;
  const choice = proposal?.decision?.choice;
  const withdrawn = choice === "withdrawn";
  const struck = choice === "reject" || withdrawn;
  const target = proposalTarget(proposal, call);
  const edit =
    target.kind !== null && target.replaces !== null && !struck
      ? { kind: target.kind, replaces: target.replaces }
      : null;
  return (
    <div
      data-v2-item-type="memory-proposal"
      className={cn(
        "flex min-w-0 flex-col gap-2 rounded-xl border border-border/70 px-4 py-3",
        withdrawn ? "bg-muted/40 text-muted-foreground" : "bg-card",
      )}
    >
      {edit !== null ? (
        <>
          <MemoryEditHeader kind={edit.kind} scope={target.scope} />
          <MemoryEditLines
            kind={edit.kind}
            replaces={edit.replaces}
            text={proposal?.decision?.text ?? proposal?.text ?? call.text}
          />
        </>
      ) : (
        <>
          <div className="min-w-0 text-sm [overflow-wrap:anywhere]">
            <span className="me-2 font-mono text-2xs text-muted-foreground">memory</span>
            {pending ? (
              <span className="font-medium">
                {target.voiceAgent ? "Remember this for the voice agent?" : "Remember this?"}
              </span>
            ) : (
              <span className={struck ? "text-muted-foreground line-through" : "font-medium"}>
                {proposal?.decision?.text ?? call.text}
              </span>
            )}
          </div>
          {struck || !target.voiceAgent ? null : <MemoryReplaces replaces={target.replaces} />}
        </>
      )}
      {pending ? (
        <>
          {edit === null ? (
            <Textarea
              aria-label="Memory to save"
              rows={2}
              value={draft ?? proposal.text}
              maxLength={MEMORY_PROPOSAL_MAX_LENGTH}
              onChange={(event) => setDraft(event.target.value)}
            />
          ) : null}
          {proposal.reason !== "" ? (
            <p className="text-xs text-muted-foreground">
              {edit === null ? proposal.reason : `Why: ${proposal.reason}`}
            </p>
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
              acceptDisabled={edit === null && (draft ?? proposal.text).trim() === ""}
              personalOnly={target.voiceAgent}
              kind={target.kind}
              onChoose={(next) => void decision.submit(proposal, next, draft ?? proposal.text)}
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
          environmentId={props.environmentId}
          projectId={projectId}
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
