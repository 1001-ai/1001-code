import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { enabledEnvironmentIds } from "@t3tools/client-runtime/state/connections";
import { createEnvironmentRpcQueryAtomFamily } from "@t3tools/client-runtime/state/runtime";
import {
  type EnvironmentId,
  EnvironmentId as EnvironmentIdSchema,
  MessageId,
  ORCHESTRATION_V2_WS_METHODS,
  ThreadId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import * as Schema from "effect/Schema";
import { useEffect } from "react";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { environmentCatalog } from "../../connection/catalog";
import { connectionAtomRuntime } from "../../connection/runtime";
import { resolveStorage } from "../../lib/storage";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { serverEnvironment } from "../../state/server";
import { environmentThreadShells } from "../../state/threads";
import { buildThreadRouteParams } from "../../threadRoutes";
import { openThreadFindOnQuery } from "../chat/threadFindStore";
import {
  EMPTY_TEAMMATE_MESSAGES,
  TEAMMATE_MESSAGE_QUERY,
  type TeammateMessage,
  type TeammateMessagesState,
  agentMessageArrivalSignal,
  handleTeammateMessages,
  rememberTeammateMessages,
  teammateMessageFromMatch,
  unreadTeammateMessages,
} from "./teammateMessages.logic";

/** Per environment, the newest time an agent's message (or a wake) landed in one of its threads. */
const arrivalSignalAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) =>
    agentMessageArrivalSignal(
      get(environmentThreadShells.quietThreadShellsAtom).filter(
        (shell) => shell.environmentId === environmentId,
      ),
    ),
  ).pipe(Atom.withLabel(`web-teammate-messages:arrival:${environmentId}`)),
);

// The client's own thread search, asked again whenever such a message lands; shells carry no text.
const routedCommentSearch = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:teammate-messages:search",
  tag: ORCHESTRATION_V2_WS_METHODS.searchThreads,
  idleTtlMs: 60_000,
  refreshTrigger: ({ environmentId }) => arrivalSignalAtom(environmentId),
});

const NO_MESSAGES: ReadonlyArray<TeammateMessage> = [];

/** Routed comments the latest searches found, across every enabled environment. */
const foundTeammateMessagesAtom = Atom.make((get) => {
  const found: TeammateMessage[] = [];
  for (const environmentId of enabledEnvironmentIds(get(environmentCatalog.catalogValueAtom))) {
    const result = get(
      routedCommentSearch({
        environmentId,
        input: { query: TEAMMATE_MESSAGE_QUERY, limit: 50 },
      }),
    );
    for (const match of AsyncResult.getOrElse(result, () => null)?.matches ?? []) {
      const message = teammateMessageFromMatch(environmentId, match);
      if (message !== null) found.push(message);
    }
  }
  const previous = Option.getOrUndefined(get.self<ReadonlyArray<TeammateMessage>>());
  const unchanged =
    previous !== undefined &&
    previous.length === found.length &&
    previous.every(
      (old, index) => old.nonce === found[index]!.nonce && old.at === found[index]!.at,
    );
  return unchanged ? previous : found.length === 0 ? NO_MESSAGES : found;
}).pipe(Atom.withLabel("web-teammate-messages:found"));

const StoredMessage = Schema.Struct({
  nonce: Schema.String,
  issue: Schema.String,
  sender: Schema.String,
  environmentId: EnvironmentIdSchema,
  threadId: ThreadId,
  messageId: Schema.NullOr(MessageId),
  preview: Schema.String,
  at: Schema.String,
});
const StoredState = Schema.Struct({
  unread: Schema.Record(Schema.String, StoredMessage),
  handled: Schema.Record(Schema.String, Schema.String),
});
const decodeStoredState = Schema.decodeUnknownOption(StoredState);

/** Per device: which routed comments were seen, and which were opened or dismissed. */
const useTeammateMessagesStore = create<TeammateMessagesState>()(
  persist((): TeammateMessagesState => EMPTY_TEAMMATE_MESSAGES, {
    name: "1001code:teammate-messages:v1",
    storage: createJSONStorage(() =>
      resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
    ),
    // Stored data from an older build or another tab may not fit; it is dropped, not trusted.
    merge: (persisted, current) => Option.getOrElse(decodeStoredState(persisted), () => current),
  }),
);

export function dismissTeammateMessages(nonces: ReadonlyArray<string>): void {
  useTeammateMessagesStore.setState((state) =>
    handleTeammateMessages(state, nonces, new Date().toISOString()),
  );
}

/**
 * The unread routed comments, newest first. Reads shells and one bounded search per environment,
 * never a thread's history; what the search found is kept, since it returns one message a thread.
 */
export function useUnreadTeammateMessages(): ReadonlyArray<TeammateMessage> {
  const found = useAtomValue(foundTeammateMessagesAtom);
  const stored = useTeammateMessagesStore();
  const merged = rememberTeammateMessages(stored, found);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps what the search found in localStorage, which outlives the search's one-per-thread answer
  useEffect(() => {
    useTeammateMessagesStore.setState((state) => rememberTeammateMessages(state, found));
  }, [found]);
  return unreadTeammateMessages(merged);
}

/** Opens the thread a comment went to, on that message, and marks it read. */
export function useOpenTeammateMessage(): (message: TeammateMessage) => Promise<void> {
  const navigate = useNavigate();
  return async (message) => {
    dismissTeammateMessages([message.nonce]);
    const ref = scopeThreadRef(message.environmentId, message.threadId);
    await navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(ref) });
    if (appAtomRegistry.get(serverEnvironment.configValueAtom(ref.environmentId))?.threadFind) {
      // The nonce is in this message only, so find lands on it and unfolds it.
      openThreadFindOnQuery(scopedThreadKey(ref), {
        query: message.nonce,
        ...(message.messageId === null
          ? {}
          : { start: { entryId: message.messageId, occurrence: 0 } }),
      });
    }
  };
}
