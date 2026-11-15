import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { createEnvironmentRpcQueryAtomFamily } from "@t3tools/client-runtime/state/runtime";
import type { ThreadTurnSubagents } from "@t3tools/client-runtime/state/thread-subagents";
import {
  type EnvironmentId,
  type ThreadCostEstimate,
  type ThreadId,
  WS_METHODS,
} from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";

import { threadCostSignal } from "../components/chat/composerStatusStrip.logic";
import { connectionAtomRuntime } from "../connection/runtime";
import { environmentThreadDetails } from "./threads";

const costSignalAtom = Atom.family((key: string) => {
  const [environmentId, threadId] = JSON.parse(key) as [EnvironmentId, ThreadId];
  const ref = scopeThreadRef(environmentId, threadId);
  let previousTurns: unknown = null;
  let previousSubagents: unknown = null;
  let signal = "";
  return Atom.make((get) => {
    const projection = get(environmentThreadDetails.quietThreadAtom(ref))?.projection ?? null;
    if (projection === null) return signal;
    if (projection.providerTurns !== previousTurns || projection.subagents !== previousSubagents) {
      previousTurns = projection.providerTurns;
      previousSubagents = projection.subagents;
      signal = threadCostSignal(projection);
    }
    return signal;
  }).pipe(Atom.setIdleTTL(0), Atom.withLabel(`web-thread-cost-signal:${key}`));
});

const threadCostQuery = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:server:thread-cost",
  tag: WS_METHODS.serverGetThreadCost,
  idleTtlMs: 60_000,
  refreshTrigger: ({ environmentId, input }) =>
    costSignalAtom(JSON.stringify([environmentId, input.threadId])),
});

// Cursor's dashboard refreshes about once a minute and lands a turn's billing within one or two.
const BILLING_RECHECK_MS = 30_000;

// Asks again while the server says billing may still replace estimated turns; no turn ends meanwhile.
const threadCostAtom = Atom.family((key: string) => {
  const [environmentId, threadId] = JSON.parse(key) as [EnvironmentId, ThreadId];
  const query = threadCostQuery({ environmentId, input: { threadId } });
  return Atom.make((get) => {
    const result = get(query);
    if (result._tag === "Success" && !result.waiting && result.value.billingPending === true) {
      const timer = setTimeout(() => get.refresh(query), BILLING_RECHECK_MS);
      get.addFinalizer(() => clearTimeout(timer));
    }
    return result;
  }).pipe(Atom.setIdleTTL(0), Atom.withLabel(`web-thread-cost:${key}`));
});

const EMPTY_COST_ATOM = Atom.make(AsyncResult.initial<ThreadCostEstimate, never>()).pipe(
  Atom.withLabel("web-thread-cost:empty"),
);

/** The last estimate the server gave; null while none has arrived or it failed (older servers). */
export function useThreadCostEstimate(
  environmentId: EnvironmentId,
  threadId: ThreadId | null,
): ThreadCostEstimate | null {
  const result = useAtomValue(
    threadId === null ? EMPTY_COST_ATOM : threadCostAtom(JSON.stringify([environmentId, threadId])),
  );
  return AsyncResult.getOrElse(result, () => null);
}

const EMPTY_SUBAGENTS_ATOM = Atom.make<ThreadTurnSubagents | null>(null).pipe(
  Atom.withLabel("web-thread-turn-subagents:empty"),
);

export function useThreadTurnSubagents(
  environmentId: EnvironmentId,
  threadId: ThreadId | null,
): ThreadTurnSubagents | null {
  return useAtomValue(
    threadId === null
      ? EMPTY_SUBAGENTS_ATOM
      : environmentThreadDetails.turnSubagentsAtom(scopeThreadRef(environmentId, threadId)),
  );
}
