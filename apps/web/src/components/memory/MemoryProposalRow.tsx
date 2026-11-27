import type { EnvironmentId, MemoryProposal, ProjectId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";

import { cn } from "~/lib/utils";
import {
  MemoryDecisionButtons,
  MemoryEditHeader,
  MemoryEditLines,
  MemoryReplaces,
  useMemoryDecision,
} from "./MemoryProposalCard";

/** One unanswered proposal with its answers, as the Memory panel and the Questions page list it. */
export function MemoryProposalRow(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly proposal: MemoryProposal;
  /** A row inside a box that already frames it and links its thread. */
  readonly embedded?: boolean;
}) {
  const { environmentId, proposal, embedded = false } = props;
  const decision = useMemoryDecision(environmentId, props.projectId);
  const navigate = useNavigate();
  const edit =
    proposal.kind === undefined || proposal.replaces === undefined
      ? null
      : { kind: proposal.kind, replaces: proposal.replaces };
  return (
    <div
      className={cn(
        "flex min-w-0 flex-col gap-1.5",
        embedded ? "px-4 py-3" : "rounded-lg border border-border/70 bg-card px-3 py-2.5",
      )}
    >
      {edit === null ? (
        <>
          <p className="text-sm [overflow-wrap:anywhere]">
            {embedded ? (
              <span className="me-2 font-mono text-2xs text-muted-foreground">memory</span>
            ) : null}
            {proposal.text}
          </p>
          {proposal.category === undefined ? null : (
            <p className="text-xs text-muted-foreground">For the voice agent</p>
          )}
          <MemoryReplaces replaces={proposal.replaces ?? null} />
        </>
      ) : (
        <>
          <MemoryEditHeader kind={edit.kind} scope={proposal.scope ?? null} />
          <MemoryEditLines kind={edit.kind} replaces={edit.replaces} text={proposal.text} />
        </>
      )}
      {proposal.reason !== "" ? (
        <p className="text-xs text-muted-foreground">
          {edit === null ? proposal.reason : `Why: ${proposal.reason}`}
        </p>
      ) : null}
      {embedded ? null : (
        <p className="text-xs text-muted-foreground">
          From{" "}
          <button
            type="button"
            className="underline underline-offset-2 hover:text-foreground"
            onClick={() =>
              void navigate({
                to: "/$environmentId/$threadId",
                params: { environmentId, threadId: proposal.threadId },
              })
            }
          >
            {proposal.threadTitle || "a thread"}
          </button>
        </p>
      )}
      {decision.error !== null ? (
        <p role="alert" className="text-xs text-destructive">
          {decision.error}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <MemoryDecisionButtons
          busy={decision.busy}
          canDecide={decision.canDecide}
          personalOnly={proposal.category !== undefined}
          kind={proposal.kind ?? null}
          onChoose={(choice, scope) => void decision.submit(proposal, choice, proposal.text, scope)}
        />
      </div>
    </div>
  );
}
