import { useAtomValue } from "@effect/atom-react";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import {
  type BoardConnection,
  type BoardSnapshot,
  type EnvironmentId,
  type ProjectId,
  WS_METHODS,
} from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";

// The server reads Linear when a board subscribes or refreshes; an idle board stops listening.
const boardSubscription = createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
  label: "environment-data:board",
  tag: WS_METHODS.boardSubscribe,
  idleTtlMs: 30_000,
});

const boardConnectionSubscription = createEnvironmentRpcSubscriptionAtomFamily(
  connectionAtomRuntime,
  {
    label: "environment-data:board:connection",
    tag: WS_METHODS.boardSubscribeConnection,
    idleTtlMs: 60_000,
  },
);

export const boardRefresh = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:board:refresh",
  tag: WS_METHODS.boardRefresh,
});

export const boardConnect = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:board:connect",
  tag: WS_METHODS.boardConnect,
});

export const boardDisconnect = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:board:disconnect",
  tag: WS_METHODS.boardDisconnect,
});

const EMPTY_BOARD_ATOM = Atom.make(AsyncResult.initial<BoardSnapshot, never>()).pipe(
  Atom.withLabel("web-board:empty"),
);

/** The project's board; null until the server answers. */
export function useBoard(
  environmentId: EnvironmentId,
  projectId: ProjectId | null,
): BoardSnapshot | null {
  const result = useAtomValue(
    projectId === null
      ? EMPTY_BOARD_ATOM
      : boardSubscription({ environmentId, input: { projectId } }),
  );
  return AsyncResult.getOrElse(result, () => null);
}

/** Who the environment reads Linear as; null until the server answers. */
export function useBoardConnection(environmentId: EnvironmentId): BoardConnection | null {
  const result = useAtomValue(boardConnectionSubscription({ environmentId, input: {} }));
  return AsyncResult.getOrElse(result, () => null);
}
