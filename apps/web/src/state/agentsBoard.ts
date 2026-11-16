import { useAtomValue } from "@effect/atom-react";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import {
  type AgentsBoardMedia,
  type AgentsBoardSnapshot,
  type EnvironmentId,
  type ProjectId,
  WS_METHODS,
} from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";

// The server fetches the agents branch when a board subscribes or refreshes, never on a timer.
const agentsBoardSubscription = createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
  label: "environment-data:agents-board",
  tag: WS_METHODS.agentsBoardSubscribe,
  idleTtlMs: 30_000,
});

export const agentsBoardRefresh = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:agents-board:refresh",
  tag: WS_METHODS.agentsBoardRefresh,
});

export const agentsBoardSetBranch = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:agents-board:set-branch",
  tag: WS_METHODS.agentsBoardSetBranch,
});

// A media file's name carries its time, so one path keeps one image; scrolling back reuses it.
const agentsBoardMediaQuery = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:agents-board:media",
  tag: WS_METHODS.agentsBoardMedia,
  idleTtlMs: 60_000,
  staleTimeMs: 10 * 60_000,
});

const EMPTY_BOARD_ATOM = Atom.make(AsyncResult.initial<AgentsBoardSnapshot, never>()).pipe(
  Atom.withLabel("web-agents-board:empty"),
);

/** The project's agents board; null until the server answers (or on a server without it). */
export function useAgentsBoard(
  environmentId: EnvironmentId | null,
  projectId: ProjectId | null,
): AgentsBoardSnapshot | null {
  const result = useAtomValue(
    environmentId === null || projectId === null
      ? EMPTY_BOARD_ATOM
      : agentsBoardSubscription({ environmentId, input: { projectId } }),
  );
  return AsyncResult.getOrElse(result, () => null);
}

/** One image of the board's `media/` folder, read while its thumbnail is on screen. */
export function useAgentsBoardMedia(
  environmentId: EnvironmentId,
  projectId: ProjectId,
  path: string,
): AsyncResult.AsyncResult<AgentsBoardMedia, unknown> {
  return useAtomValue(agentsBoardMediaQuery({ environmentId, input: { projectId, path } }));
}
