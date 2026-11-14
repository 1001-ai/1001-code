import { useAtomValue } from "@effect/atom-react";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import { type EnvironmentId, type TeamCatalogSnapshot, WS_METHODS } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";

const teamCatalogSubscription = createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
  label: "environment-data:team-catalog",
  tag: WS_METHODS.teamCatalogSubscribe,
  idleTtlMs: 60_000,
});

export const teamCatalogRefresh = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:team-catalog:refresh",
  tag: WS_METHODS.teamCatalogRefresh,
});

export const teamCatalogSetSource = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:team-catalog:set-source",
  tag: WS_METHODS.teamCatalogSetSource,
});

const EMPTY_CATALOG_ATOM = Atom.make(AsyncResult.initial<TeamCatalogSnapshot, never>()).pipe(
  Atom.withLabel("web-team-catalog:empty"),
);

/** The environment's team catalog; null until it arrives, or when the server has none (older servers). */
export function useTeamCatalog(environmentId: EnvironmentId | null): TeamCatalogSnapshot | null {
  const result = useAtomValue(
    environmentId === null
      ? EMPTY_CATALOG_ATOM
      : teamCatalogSubscription({ environmentId, input: {} }),
  );
  return AsyncResult.getOrElse(result, () => null);
}
