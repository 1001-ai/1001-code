import { useAtomValue } from "@effect/atom-react";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import {
  type EnvironmentId,
  type ProjectId,
  type PreferencesView,
  WS_METHODS,
} from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";

const preferencesSubscription = createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
  label: "environment-data:preferences",
  tag: WS_METHODS.preferencesSubscribe,
  idleTtlMs: 30_000,
});

export const preferencesPropose = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:preferences:propose",
  tag: WS_METHODS.preferencesPropose,
});

const EMPTY_ATOM = Atom.make(AsyncResult.initial<PreferencesView, never>()).pipe(
  Atom.withLabel("web-preferences:empty"),
);

/** The preferences agents get in the project's threads; null until the server answers. */
export function usePreferences(
  environmentId: EnvironmentId,
  projectId: ProjectId | null,
): PreferencesView | null {
  const result = useAtomValue(
    projectId === null
      ? EMPTY_ATOM
      : preferencesSubscription({ environmentId, input: { projectId } }),
  );
  return AsyncResult.getOrElse(result, () => null);
}
