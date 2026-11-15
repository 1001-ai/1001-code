import { useAtomValue } from "@effect/atom-react";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import {
  type EnvironmentId,
  type ProjectId,
  type MemoryView,
  WS_METHODS,
} from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";

const memorySubscription = createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
  label: "environment-data:memory",
  tag: WS_METHODS.memorySubscribe,
  idleTtlMs: 30_000,
});

export const memoryPropose = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:memory:propose",
  tag: WS_METHODS.memoryPropose,
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
