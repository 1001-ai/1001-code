import { parseThreadKey, threadKey, threadRefsEqual } from "@t3tools/client-runtime/state/entities";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { PendingThreadRequests } from "@t3tools/client-runtime/state/thread-requests";
import type { ScopedThreadRef } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";

import {
  type EnvironmentPendingMemoryProposal,
  pendingMemoryProposalsAtom,
} from "../../state/memory";
import { environmentThreadDetails, environmentThreadShells } from "../../state/threads";
import {
  askedQuestionCards,
  isWaitingOnUser,
  openQuestionCards,
  sameOpenQuestionCards,
  type OpenQuestionCard,
} from "./questionsPage.logic";

export interface QuestionsThreadEntry {
  readonly ref: ScopedThreadRef;
  readonly shell: EnvironmentThreadShell;
  /** The thread's projection is here, so an empty card list means none are open. */
  readonly loaded: boolean;
  /** Cards behind `openQuestionsAt` are in the loaded history, answered or not. */
  readonly cardsAsked: boolean;
  readonly cards: ReadonlyArray<OpenQuestionCard>;
  readonly requests: PendingThreadRequests;
  /** The thread's unanswered memory proposals, newest first. */
  readonly proposals: ReadonlyArray<EnvironmentPendingMemoryProposal>;
}

const NO_CARDS: ReadonlyArray<OpenQuestionCard> = [];
const NO_REQUESTS: PendingThreadRequests = { approvals: [], userInputs: [] };
const NO_PROPOSALS: ReadonlyArray<EnvironmentPendingMemoryProposal> = [];

/** Pending proposals by thread key, for threads the page can show. */
const proposalsByThreadAtom = Atom.make((get) => {
  const previous = Option.getOrUndefined(
    get.self<ReadonlyMap<string, ReadonlyArray<EnvironmentPendingMemoryProposal>>>(),
  );
  const next = new Map<string, EnvironmentPendingMemoryProposal[]>();
  for (const pending of get(pendingMemoryProposalsAtom)) {
    const key = threadKey({
      environmentId: pending.environmentId,
      threadId: pending.proposal.threadId,
    });
    const list = next.get(key);
    if (list === undefined) next.set(key, [pending]);
    else list.push(pending);
  }
  if (previous === undefined) return next;
  // Keep each thread's previous list while its proposals are the same ones.
  const kept = new Map<string, ReadonlyArray<EnvironmentPendingMemoryProposal>>();
  let changed = previous.size !== next.size;
  for (const [key, list] of next) {
    const old = previous.get(key);
    const same =
      old !== undefined &&
      old.length === list.length &&
      old.every((proposal, index) => proposal.proposal.id === list[index]!.proposal.id);
    kept.set(key, same ? old : list);
    if (!same) changed = true;
  }
  return changed ? kept : previous;
}).pipe(Atom.withLabel("questions-memory-proposals-by-thread"));

const waitingThreadRefsAtom = Atom.make((get) => {
  const previous = Option.getOrUndefined(get.self<ReadonlyArray<ScopedThreadRef>>());
  const proposals = get(proposalsByThreadAtom);
  const next = get(environmentThreadShells.quietThreadShellsAtom).flatMap((shell) => {
    const ref = { environmentId: shell.environmentId, threadId: shell.id };
    const visible = shell.archivedAt === null && (shell.deletedAt ?? null) === null;
    return isWaitingOnUser(shell) || (visible && proposals.has(threadKey(ref))) ? [ref] : [];
  });
  return previous !== undefined && threadRefsEqual(previous, next) ? previous : next;
}).pipe(Atom.withLabel("questions-waiting-thread-refs"));

/**
 * Reads only shells and the small pending-proposal stream, so the sidebar's dot never subscribes
 * to a thread's history.
 */
export const hasWaitingQuestionsAtom = Atom.make(
  (get) => get(waitingThreadRefsAtom).length > 0,
).pipe(Atom.withLabel("questions-has-waiting"));

interface ThreadCards {
  readonly asked: boolean;
  readonly open: ReadonlyArray<OpenQuestionCard>;
}

const NO_THREAD_CARDS: ThreadCards = { asked: false, open: NO_CARDS };

const openCardsAtomFamily = Atom.family((key: string) => {
  const ref = parseThreadKey(key);
  let previous = NO_THREAD_CARDS;
  return Atom.make((get) => {
    const repliedAt =
      get(environmentThreadShells.quietThreadShellAtom(ref))?.latestUserAuthoredMessageAt ?? null;
    const items = get(environmentThreadDetails.timelineVisibleTurnItemsAtom(ref));
    const asked = askedQuestionCards(items, repliedAt);
    const open = openQuestionCards(items, asked);
    const next = { asked: asked.length > 0, open };
    if (next.asked !== previous.asked || !sameOpenQuestionCards(previous.open, open)) {
      previous = next;
    }
    return previous;
  }).pipe(Atom.setIdleTTL(0), Atom.withLabel(`questions-open-cards:${key}`));
});

export function waitingSince(entry: QuestionsThreadEntry): string {
  const times = [
    ...(entry.shell.openQuestionsAt ? [entry.shell.openQuestionsAt] : []),
    ...entry.requests.approvals.map((approval) => approval.createdAt),
    ...entry.requests.userInputs.map((input) => input.createdAt),
    ...entry.proposals.map((pending) => pending.proposal.createdAt),
  ];
  return times.toSorted()[0] ?? entry.shell.updatedAt;
}

/**
 * Every thread an agent waits on, newest wait first. Only threads whose shell says a question or
 * an approval waits subscribe to their detail, and only while the page reads this.
 */
export const questionsThreadEntriesAtom = Atom.make((get) => {
  const previous = Option.getOrElse(
    get.self<ReadonlyArray<QuestionsThreadEntry>>(),
    (): ReadonlyArray<QuestionsThreadEntry> => [],
  );
  const proposalsByThread = get(proposalsByThreadAtom);
  const next = get(waitingThreadRefsAtom).flatMap((ref): QuestionsThreadEntry[] => {
    const shell = get(environmentThreadShells.quietThreadShellAtom(ref));
    if (shell === null) return [];
    const proposals = proposalsByThread.get(threadKey(ref)) ?? NO_PROPOSALS;
    // A thread that waits only on proposals needs nothing from its history.
    if (!isWaitingOnUser(shell)) {
      return [
        {
          ref,
          shell,
          loaded: true,
          cardsAsked: false,
          cards: NO_CARDS,
          requests: NO_REQUESTS,
          proposals,
        },
      ];
    }
    if (get(environmentThreadDetails.statusAtom(ref)) === "deleted") return [];
    const threadCards = shell.openQuestionsAt
      ? get(openCardsAtomFamily(threadKey(ref)))
      : NO_THREAD_CARDS;
    const cards = threadCards.open;
    const cardsAsked = threadCards.asked;
    const requests =
      shell.hasPendingApprovals || shell.hasPendingUserInput
        ? (get(environmentThreadDetails.pendingRequestsAtom(ref)) ?? NO_REQUESTS)
        : NO_REQUESTS;
    const loaded = get(environmentThreadDetails.quietThreadAtom(ref)) !== null;
    return [{ ref, shell, loaded, cardsAsked, cards, requests, proposals }];
  });
  const sorted = next
    .map((entry) => [waitingSince(entry), entry] as const)
    .toSorted(([left], [right]) => (left < right ? 1 : left > right ? -1 : 0))
    .map(([, entry]) => entry);
  const unchanged =
    sorted.length === previous.length &&
    sorted.every((entry, index) => {
      const old = previous[index]!;
      return (
        old.shell === entry.shell &&
        old.loaded === entry.loaded &&
        old.cardsAsked === entry.cardsAsked &&
        old.cards === entry.cards &&
        old.requests === entry.requests &&
        old.proposals === entry.proposals
      );
    });
  return unchanged ? previous : sorted;
}).pipe(Atom.withLabel("questions-thread-entries"));
