import type { RunId } from "@t3tools/contracts";

import type { TimelineEntry } from "../../session-logic";
import { messageHasQuestionCards } from "./questionBlock.logic";

function isSteerEntry(entry: TimelineEntry): boolean {
  return (
    entry.kind === "message" &&
    entry.message.role === "user" &&
    (entry.message.inputIntent === "steer" ||
      entry.message.inputIntent === "promoted_queued_to_steer")
  );
}

function isResponseBoundary(entry: TimelineEntry): boolean {
  return (
    (entry.kind === "message" && entry.message.role === "user" && !isSteerEntry(entry)) ||
    (entry.kind === "work" && entry.entry.itemType === "notification")
  );
}

function entryRunKey(entry: TimelineEntry, fallbackRunId: RunId | null): RunId | null {
  if (entry.kind === "message") return entry.message.runId ?? fallbackRunId;
  if (entry.kind === "work") return entry.entry.runId ?? fallbackRunId;
  if (entry.kind === "event") return entry.projectedItem.item.runId ?? fallbackRunId;
  return fallbackRunId;
}

/**
 * Fork-added assistant replies that stay visible when a run folds or Zen mode filters it:
 * 1. Finished assistant messages carrying question cards.
 * 2. The last completed unphased assistant reply directly before a native steer in the same run,
 *    mirroring upstream's retention of completed replies before superseded-attempt steers.
 */
export function addForkRetainedAssistantReplyEntryIds(
  timelineEntries: ReadonlyArray<TimelineEntry>,
  replyEntryIds: Set<string>,
): void {
  const lastOutputByRunId = new Map<RunId, TimelineEntry>();
  let currentResponseRunId: RunId | null = null;

  for (const entry of timelineEntries) {
    if (entry.kind === "message" && messageHasQuestionCards(entry.message)) {
      replyEntryIds.add(entry.id);
    }

    if (isResponseBoundary(entry)) {
      const boundaryRunId = entryRunKey(entry, null);
      currentResponseRunId = boundaryRunId ?? (`runless:${entry.id}` as RunId);
      lastOutputByRunId.delete(currentResponseRunId);
      continue;
    }

    if (isSteerEntry(entry)) {
      const steerRunId = entryRunKey(entry, currentResponseRunId);
      if (steerRunId !== null) {
        const candidate = lastOutputByRunId.get(steerRunId);
        const item = candidate?.kind === "message" ? candidate.projectedItem?.item : undefined;
        if (
          candidate?.kind === "message" &&
          candidate.attempt?.status !== "superseded" &&
          !candidate.message.streaming &&
          item?.type === "assistant_message" &&
          item.phase === undefined &&
          item.status === "completed" &&
          item.completedAt !== null
        ) {
          replyEntryIds.add(candidate.id);
        }
        lastOutputByRunId.delete(steerRunId);
      }
      continue;
    }

    if (
      entry.attempt?.status === "superseded" ||
      (entry.kind === "message" && entry.message.role === "user") ||
      (entry.kind === "work" &&
        (entry.entry.itemType === "system_notice" || entry.entry.itemType === "notification")) ||
      (entry.kind !== "message" && entry.kind !== "work")
    ) {
      continue;
    }

    const runId = entryRunKey(entry, currentResponseRunId);
    if (runId !== null) {
      lastOutputByRunId.set(runId, entry);
    }
  }
}
