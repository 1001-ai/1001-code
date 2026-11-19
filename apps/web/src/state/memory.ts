import { useAtomValue } from "@effect/atom-react";
import { enabledEnvironmentIds } from "@t3tools/client-runtime/state/connections";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import {
  type EnvironmentId,
  type ProjectId,
  type MemoryView,
  type PendingMemoryProposal,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";

const memorySubscription = createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
  label: "environment-data:memory",
  tag: WS_METHODS.memorySubscribe,
  idleTtlMs: 30_000,
});

const pendingMemorySubscription = createEnvironmentRpcSubscriptionAtomFamily(
  connectionAtomRuntime,
  {
    label: "environment-data:memory-pending",
    tag: WS_METHODS.memorySubscribePending,
    idleTtlMs: 30_000,
  },
);

export const memoryPropose = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:memory:propose",
  tag: WS_METHODS.memoryPropose,
});

export const memoryDecide = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:memory:decide",
  tag: WS_METHODS.memoryDecide,
});

export const memoryUndo = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:memory:undo",
  tag: WS_METHODS.memoryUndo,
});

const EMPTY_ATOM = Atom.make(AsyncResult.initial<MemoryView, never>()).pipe(
  Atom.withLabel("web-memory:empty"),
);

/** The memory agents get in the project's threads; null until the server answers. */
export function useMemory(
  environmentId: EnvironmentId,
  projectId: ProjectId | null,
): MemoryView | null {
  const result = useAtomValue(
    projectId === null ? EMPTY_ATOM : memorySubscription({ environmentId, input: { projectId } }),
  );
  return AsyncResult.getOrElse(result, () => null);
}

export interface EnvironmentPendingMemoryProposal extends PendingMemoryProposal {
  readonly environmentId: EnvironmentId;
}

const NO_PENDING: ReadonlyArray<PendingMemoryProposal> = [];

/**
 * Every connected environment's unanswered proposals. An environment whose server lacks the
 * stream, or has not answered yet, has none.
 */
export const pendingMemoryProposalsAtom = Atom.make((get) => {
  const previous = Option.getOrUndefined(
    get.self<ReadonlyArray<EnvironmentPendingMemoryProposal>>(),
  );
  const next: EnvironmentPendingMemoryProposal[] = [];
  for (const environmentId of enabledEnvironmentIds(get(environmentCatalog.catalogValueAtom))) {
    const result = get(pendingMemorySubscription({ environmentId, input: {} }));
    for (const pending of AsyncResult.getOrElse(result, () => NO_PENDING)) {
      next.push({ environmentId, ...pending });
    }
  }
  // A pending proposal never changes, so its id says whether the list did.
  const unchanged =
    previous !== undefined &&
    previous.length === next.length &&
    previous.every(
      (old, index) =>
        old.environmentId === next[index]!.environmentId &&
        old.proposal.id === next[index]!.proposal.id,
    );
  return unchanged ? previous : next;
}).pipe(Atom.withLabel("web-memory:pending"));
