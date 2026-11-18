import { useAtomValue } from "@effect/atom-react";
import { createEnvironmentRpcSubscriptionAtomFamily } from "@t3tools/client-runtime/state/runtime";
import { type EnvironmentId, type ProjectId, WS_METHODS } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import * as Stream from "effect/Stream";

import {
  applyProjectMomentsItem,
  EMPTY_PROJECT_MOMENTS,
  type ProjectMomentsState,
} from "../components/chat/timelineMoments.logic";
import { connectionAtomRuntime } from "../connection/runtime";

// Each subscription starts with a snapshot, so a resubscribe replaces whatever came before.
const projectMomentsSubscription = createEnvironmentRpcSubscriptionAtomFamily(
  connectionAtomRuntime,
  {
    label: "environment-data:project-moments",
    tag: WS_METHODS.projectMomentsSubscribe,
    idleTtlMs: 30_000,
    transform: (stream) =>
      stream.pipe(
        Stream.mapAccum(
          () => EMPTY_PROJECT_MOMENTS,
          (state, item) => {
            const next = applyProjectMomentsItem(state, item);
            return [next, [next]] as const;
          },
        ),
      ),
  },
);

const EMPTY_MOMENTS_ATOM = Atom.make(AsyncResult.initial<ProjectMomentsState, never>()).pipe(
  Atom.withLabel("web-project-moments:empty"),
);

/** The project's recent moments, oldest first; null until the server answers. */
export function useProjectMoments(
  environmentId: EnvironmentId | null,
  projectId: ProjectId | null,
): ProjectMomentsState | null {
  const result = useAtomValue(
    environmentId === null || projectId === null
      ? EMPTY_MOMENTS_ATOM
      : projectMomentsSubscription({ environmentId, input: { projectId } }),
  );
  return AsyncResult.getOrElse(result, () => null);
}
