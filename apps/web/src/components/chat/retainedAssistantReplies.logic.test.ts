import { MessageId, NodeId, RunAttemptId, RunId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import type { TimelineEntry } from "../../session-logic";
import { deriveMessagesTimelineRows } from "./MessagesTimeline.logic";

describe("retained assistant replies in the timeline", () => {
  const at = (second: number) => `2026-01-01T00:00:${String(second).padStart(2, "0")}Z`;
  const runId = RunId.make("run-retained-replies");
  const activeAttempt = {
    id: RunAttemptId.make("attempt-1"),
    runId,
    attemptOrdinal: 1,
    rootNodeId: NodeId.make("node-attempt-1"),
    status: "completed" as const,
    completedAt: DateTime.makeUnsafe(at(30)),
  };

  const userEntry = (
    id: string,
    second: number,
    inputIntent: "turn_start" | "steer" | "promoted_queued_to_steer",
  ): TimelineEntry => ({
    kind: "message",
    id,
    createdAt: at(second),
    attempt: activeAttempt,
    message: {
      id: MessageId.make(id),
      role: "user",
      text: id,
      runId,
      inputIntent,
      createdAt: at(second),
      updatedAt: at(second),
      streaming: false,
    },
  });

  const assistantEntry = (
    id: string,
    startedSecond: number,
    completedSecond: number,
    options?: {
      readonly phase?: "commentary" | "partial_answer" | "final_answer";
      readonly streaming?: boolean;
      readonly attempt?: TimelineEntry["attempt"];
    },
  ): TimelineEntry => ({
    kind: "message",
    id,
    createdAt: at(startedSecond),
    attempt: options?.attempt ?? activeAttempt,
    message: {
      id: MessageId.make(id),
      role: "assistant",
      text: `${id} reply text`,
      runId,
      createdAt: at(startedSecond),
      updatedAt: at(completedSecond),
      streaming: options?.streaming ?? false,
    },
    projectedItem: {
      item: {
        type: "assistant_message",
        ...(options?.phase === undefined ? {} : { phase: options.phase }),
        status: options?.streaming ? "running" : "completed",
        completedAt: options?.streaming ? null : DateTime.makeUnsafe(at(completedSecond)),
      },
    } as never,
  });

  const workEntry = (
    id: string,
    second: number,
    itemType: "command_execution" | "system_notice" | "notification" = "command_execution",
  ): TimelineEntry => ({
    kind: "work",
    id,
    createdAt: at(second),
    attempt: activeAttempt,
    entry: {
      id,
      createdAt: at(second),
      runId,
      label: id,
      tone: itemType === "command_execution" ? "tool" : "info",
      itemType,
    },
  });

  it.each(["steer", "promoted_queued_to_steer"] as const)(
    "retains a completed unphased assistant reply right before a native %s while still folding mid-turn narration",
    (intent) => {
      const timelineEntries: ReadonlyArray<TimelineEntry> = [
        userEntry("prompt", 0, "turn_start"),
        workEntry("tool-1", 1),
        assistantEntry("narration", 2, 3),
        workEntry("tool-2", 4),
        // Steer arrives while the agent finishes streaming this reply (started 5, steer 7, ended 9).
        assistantEntry("reply-before-steer", 5, 9),
        userEntry("steer-msg", 7, intent),
        workEntry("tool-3", 12),
        assistantEntry("final-reply", 15, 18),
      ];

      for (const visibility of ["showAll", "zen"] as const) {
        const rows = deriveMessagesTimelineRows({
          timelineEntries,
          toolCallVisibility: visibility,
          latestRun: { runId, status: "completed", startedAt: at(0), completedAt: at(18) },
          isWorking: false,
          turnDiffSummaries: [],
          supportsConversationRollback: false,
        });
        const ids = rows.map((row) => row.id);
        expect(ids).toContain("reply-before-steer");
        expect(ids).toContain("final-reply");
        expect(ids).not.toContain("narration");
      }
    },
  );

  it("ignores non-substantive notices between a reply and a native steer, but folds explicit commentary", () => {
    const timelineEntries: ReadonlyArray<TimelineEntry> = [
      userEntry("prompt", 0, "turn_start"),
      workEntry("tool-1", 1),
      assistantEntry("commentary-before-steer", 2, 4, { phase: "commentary" }),
      userEntry("steer-1", 5, "steer"),
      assistantEntry("reply-before-notice-and-steer", 6, 8),
      workEntry("notice", 9, "system_notice"),
      userEntry("steer-2", 10, "steer"),
      workEntry("tool-2", 12),
      assistantEntry("final-reply", 15, 18),
    ];

    const rows = deriveMessagesTimelineRows({
      timelineEntries,
      latestRun: { runId, status: "completed", startedAt: at(0), completedAt: at(18) },
      isWorking: false,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });
    const ids = rows.map((row) => row.id);
    expect(ids).not.toContain("commentary-before-steer");
    expect(ids).toContain("reply-before-notice-and-steer");
    expect(ids).toContain("final-reply");
  });

  it("keeps phase=final_answer background/wake replies visible while folding mid-turn narration", () => {
    const timelineEntries: ReadonlyArray<TimelineEntry> = [
      userEntry("prompt", 0, "turn_start"),
      assistantEntry("narration-1", 1, 2),
      workEntry("tool-1", 3),
      assistantEntry("wake-reply-1", 5, 6, { phase: "final_answer" }),
      workEntry("tool-2", 10),
      assistantEntry("narration-2", 11, 12),
      workEntry("tool-3", 13),
      assistantEntry("final-reply", 15, 18, { phase: "final_answer" }),
    ];

    for (const visibility of ["showAll", "zen"] as const) {
      const rows = deriveMessagesTimelineRows({
        timelineEntries,
        toolCallVisibility: visibility,
        latestRun: { runId, status: "completed", startedAt: at(0), completedAt: at(18) },
        isWorking: false,
        turnDiffSummaries: [],
        supportsConversationRollback: false,
      });
      const ids = rows.map((row) => row.id);
      expect(ids).toContain("wake-reply-1");
      expect(ids).toContain("final-reply");
      expect(ids).not.toContain("narration-1");
      expect(ids).not.toContain("narration-2");
    }
  });
});
