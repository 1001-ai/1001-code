import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  fullAccessOverrideExplanation,
  type ThreadPendingApproval,
} from "@t3tools/client-runtime/state/thread-requests";
import { AuthOrchestrationOperateScope, type ScopedThreadRef } from "@t3tools/contracts";
import { useState } from "react";

import { useEnvironmentScope } from "~/state/session";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import { ComposerPendingApprovalActions } from "../chat/ComposerPendingApprovalActions";

/** One tool approval as a row of its thread's group, answered with the composer's actions. */
export function QuestionsApproval({
  threadRef,
  approval,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly approval: ThreadPendingApproval;
}) {
  const canRespond = useEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope);
  const respond = useAtomCommand(threadEnvironment.respondToApproval, { reportFailure: false });
  const [responding, setResponding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <section aria-label="Approval" className="flex min-w-0 flex-col gap-2 px-4 py-3 text-xs">
      <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted px-2.5 py-2 font-mono">
        {approval.detail || approval.requestKind}
      </pre>
      {approval.appName ? <p className="text-muted-foreground">{approval.appName}</p> : null}
      {approval.responseCapability !== "live" ? (
        <p className="text-warning">
          Provider process is gone. Interrupt or restart the thread to respond.
        </p>
      ) : null}
      {approval.reason ? <p className="text-muted-foreground">{approval.reason}</p> : null}
      {approval.fullAccessOverride ? (
        <p className="text-muted-foreground">
          {fullAccessOverrideExplanation(approval.fullAccessOverride)}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <ComposerPendingApprovalActions
          presentation="inline"
          requestId={approval.requestId}
          isResponding={responding}
          canRespond={approval.responseCapability === "live"}
          disabled={!canRespond}
          options={approval.options}
          onRespondToApproval={async (requestId, decision) => {
            if (!canRespond || responding) return;
            setResponding(true);
            setError(null);
            const result = await respond({
              environmentId: threadRef.environmentId,
              input: { threadId: threadRef.threadId, requestId, decision },
            });
            if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
              const failure = squashAtomCommandFailure(result);
              setError(
                failure instanceof Error ? failure.message : "Failed to submit approval decision.",
              );
            }
            setResponding(false);
            return result;
          }}
        />
      </div>
      {error !== null ? (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      ) : null}
    </section>
  );
}
