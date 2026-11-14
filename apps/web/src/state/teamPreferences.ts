import { useAtomValue } from "@effect/atom-react";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import {
  type EnvironmentId,
  type ProjectId,
  type TeamPreferencesView,
  WS_METHODS,
} from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";

const teamPreferencesSubscription = createEnvironmentRpcSubscriptionAtomFamily(
  connectionAtomRuntime,
  {
    label: "environment-data:team-preferences",
    tag: WS_METHODS.teamPreferencesSubscribe,
    idleTtlMs: 30_000,
  },
);

export const teamPreferencesPropose = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:team-preferences:propose",
  tag: WS_METHODS.teamPreferencesPropose,
});

const EMPTY_ATOM = Atom.make(AsyncResult.initial<TeamPreferencesView, never>()).pipe(
  Atom.withLabel("web-team-preferences:empty"),
);

/** The preferences agents get in the project's threads; null until the server answers. */
export function useTeamPreferences(
  environmentId: EnvironmentId,
  projectId: ProjectId | null,
): TeamPreferencesView | null {
  const result = useAtomValue(
    projectId === null
      ? EMPTY_ATOM
      : teamPreferencesSubscription({ environmentId, input: { projectId } }),
  );
  return AsyncResult.getOrElse(result, () => null);
}
