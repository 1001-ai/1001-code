import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";
import * as Schema from "effect/Schema";
import { useEffect } from "react";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "../../lib/storage";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { serverEnvironment } from "../../state/server";
import { environmentThreadDetails, environmentThreadShells } from "../../state/threads";
import { buildThreadRouteParams } from "../../threadRoutes";
import { openThreadFindOnQuery } from "../chat/threadFindStore";
import {
  EMPTY_TEAMMATE_MESSAGES,
  type ScanCandidate,
  type ScanShell,
  type TeammateMessage,
  type TeammateMessagesState,
  handleTeammateMessages,
  recordScan,
  rememberTeammateMessages,
  scanCandidates,
  scanKey,
  teammateMessagesIn,
  unreadTeammateMessages,
} from "./teammateMessages.logic";

/** Shells whose last user-role message the user did not type; changes only when one lands. */
const arrivalShellsAtom = Atom.make((get) => {
  const next = get(environmentThreadShells.quietThreadShellsAtom).flatMap((shell): ScanShell[] =>
    shell.latestUserMessageAt !== null &&
    shell.latestUserMessageAt !== (shell.latestUserAuthoredMessageAt ?? null)
      ? [
          {
            environmentId: shell.environmentId,
            id: shell.id,
            latestUserMessageAt: shell.latestUserMessageAt,
            latestUserAuthoredMessageAt: shell.latestUserAuthoredMessageAt ?? null,
            updatedAt: shell.updatedAt,
            archivedAt: shell.archivedAt,
            deletedAt: shell.deletedAt,
          },
        ]
      : [],
  );
  const previous = Option.getOrUndefined(get.self<ReadonlyArray<ScanShell>>());
  const same = (left: ScanShell, right: ScanShell) =>
    left.environmentId === right.environmentId &&
    left.id === right.id &&
    left.latestUserMessageAt === right.latestUserMessageAt &&
    left.archivedAt === right.archivedAt &&
    left.deletedAt === right.deletedAt;
  return previous !== undefined &&
    previous.length === next.length &&
    previous.every((shell, index) => same(shell, next[index]!))
    ? previous
    : next;
}).pipe(Atom.withLabel("web-teammate-messages:arrival-shells"));

/** A thread that never answers is skipped this pass and tried again on the next arrival. */
const READ_TIMEOUT_MS = 15_000;

type ScannedMessages = Parameters<typeof teammateMessagesIn>[2];

/**
 * One thread's recent user-role messages, through the same detail subscription the chat uses (a
 * bounded snapshot of recent history), held only until it is live. Null when it cannot be read.
 */
function readRecentMessages(candidate: ScanCandidate): Promise<ScannedMessages | null> {
  const atom = environmentThreadDetails.stateAtom(
    scopeThreadRef(candidate.environmentId, candidate.threadId),
  );
  return new Promise((resolve) => {
    let settled = false;
    let unsubscribe: (() => void) | null = null;
    const finish = (value: ScannedMessages | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
      // Not inside the registry's own notification.
      queueMicrotask(() => unsubscribe?.());
    };
    const timer = setTimeout(() => finish(null), READ_TIMEOUT_MS);
    unsubscribe = appAtomRegistry.subscribe(
      atom,
      (state) => {
        if (state.status === "deleted") return finish([]);
        if (Option.isSome(state.error)) return finish(null);
        const projection = Option.getOrNull(state.data);
        if (state.status !== "live" || projection === null) return;
        finish(
          projection.messages.flatMap((message) =>
            message.role === "user"
              ? [
                  {
                    id: message.id,
                    role: message.role,
                    text: message.text,
                    createdAt: DateTime.formatIso(message.createdAt),
                    updatedAt: DateTime.formatIso(message.updatedAt),
                  },
                ]
              : [],
          ),
        );
      },
      { immediate: true },
    );
    if (settled) queueMicrotask(() => unsubscribe?.());
  });
}

const reading = new Set<string>();

/** Reads each candidate in turn, keeping its routed comments and moving its watermark. */
async function scanThreads(candidates: ReadonlyArray<ScanCandidate>): Promise<void> {
  for (const candidate of candidates) {
    const key = scanKey(candidate.environmentId, candidate.threadId);
    if (reading.has(key)) continue;
    reading.add(key);
    try {
      const messages = await readRecentMessages(candidate);
      if (messages === null) continue;
      const found = teammateMessagesIn(
        candidate.environmentId,
        candidate.threadId,
        messages,
        useTeammateMessagesStore.getState().scannedAt[key],
      );
      useTeammateMessagesStore.setState((state) =>
        recordScan(rememberTeammateMessages(state, found), candidate),
      );
    } finally {
      reading.delete(key);
    }
  }
}

const StoredMessage = Schema.Struct({
  nonce: Schema.String,
  issue: Schema.String,
  sender: Schema.String,
  environmentId: EnvironmentId,
  threadId: ThreadId,
  messageId: Schema.NullOr(MessageId),
  preview: Schema.String,
  at: Schema.String,
});
const StoredState = Schema.Struct({
  unread: Schema.Record(Schema.String, StoredMessage),
  handled: Schema.Record(Schema.String, Schema.String),
  scannedAt: Schema.Record(Schema.String, Schema.String),
});
const decodeStoredState = Schema.decodeUnknownOption(StoredState);

/** Per device: routed comments seen, which were opened or dismissed, and how far each thread was read. */
const useTeammateMessagesStore = create<TeammateMessagesState>()(
  persist((): TeammateMessagesState => EMPTY_TEAMMATE_MESSAGES, {
    name: "1001code:teammate-messages:v2",
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
 * The unread routed comments, newest first. Shells say which threads got a message the user did
 * not type since this device last looked; only those threads' newest messages are read.
 */
export function useUnreadTeammateMessages(): ReadonlyArray<TeammateMessage> {
  const shells = useAtomValue(arrivalShellsAtom);
  const unread = useTeammateMessagesStore((state) => state.unread);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the threads that just got an agent's message over the detail subscription, and stores what it finds in localStorage
  useEffect(() => {
    void scanThreads(
      scanCandidates(shells, useTeammateMessagesStore.getState().scannedAt, Date.now()),
    );
  }, [shells]);
  return unreadTeammateMessages(unread);
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
