import {
  EventId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as Board from "./Board.ts";
import { isLinearWriteToolName, watch } from "./LinearWriteWatch.ts";

describe("isLinearWriteToolName", () => {
  it.each([
    // Claude, and Cursor's `mcp__<provider>__<tool>`.
    "mcp__claude_ai_Linear__save_issue",
    "mcp__linear__create_comment",
    "mcp__plugin_linear_linear__update_issue",
    "mcp__claude_ai_Linear__delete_attachment",
    "mcp__claude_ai_Linear__unshare_issue",
    // Codex and ACP agents' `<server>.<tool>`.
    "linear.save_issue",
    "Linear.create_issue",
    // OpenCode's `<server>_<tool>`.
    "linear_save_issue",
    "linear_mcp_merge_diff",
  ])("%s writes", (name) => {
    expect(isLinearWriteToolName(name)).toBe(true);
  });

  it.each([
    "mcp__claude_ai_Linear__list_issues",
    "mcp__claude_ai_Linear__get_issue",
    "mcp__claude_ai_Linear__get_status_updates",
    "mcp__claude_ai_Linear__search_documentation",
    "mcp__claude_ai_Linear__extract_images",
    "mcp__claude_ai_Linear__prepare_file_upload",
    "mcp__claude_ai_Linear__whoami",
    "linear.list_comments",
    "linear_get_issue_status",
    "codex_apps.linear_list_issues",
    // Writes, but not to Linear.
    "mcp__claude_ai_Notion__notion-update-page",
    "mcp__github__create_issue",
    "github.create_pull_request",
    "jira_create_issue",
    "Bash",
    "",
    null,
  ])("%s does not", (name) => {
    expect(isLinearWriteToolName(name)).toBe(false);
  });
});

const threadId = ThreadId.make("thread-1");
const at = DateTime.makeUnsafe("2026-11-15T10:00:00.000Z");

const toolEvent = (
  id: string,
  toolName: string,
  status: OrchestrationV2TurnItem["status"],
): OrchestrationV2DomainEvent => ({
  type: "turn-item.updated",
  id: EventId.make(`event-${id}-${status}`),
  threadId,
  runId: RunId.make("run-1"),
  occurredAt: at,
  payload: {
    id: TurnItemId.make(id),
    threadId,
    runId: RunId.make("run-1"),
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    status,
    title: null,
    startedAt: at,
    completedAt: status === "completed" ? at : null,
    updatedAt: at,
    type: "dynamic_tool",
    toolName,
    input: {},
  },
});

/** How many times the watcher asked open boards to refresh while it read `events`. */
const refreshesFor = (events: ReadonlyArray<OrchestrationV2DomainEvent>) =>
  Effect.gen(function* () {
    let refreshes = 0;
    const ended = yield* Deferred.make<void>();
    yield* watch.pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(Board.Board)({ refreshOpen: Effect.sync(() => void (refreshes += 1)) }),
          Layer.mock(Orchestrator.OrchestratorV2)({
            streamDomainEvents: Stream.fromIterable(events).pipe(
              Stream.ensuring(Deferred.succeed(ended, undefined)),
            ),
          }),
        ),
      ),
    );
    yield* Deferred.await(ended);
    return refreshes;
  }).pipe(Effect.scoped);

describe("watch", () => {
  it.effect("refreshes open boards once per finished Linear write", () =>
    Effect.gen(function* () {
      const save = "mcp__claude_ai_Linear__save_issue";
      expect(
        yield* refreshesFor([
          toolEvent("write-1", save, "running"),
          toolEvent("read-1", "mcp__claude_ai_Linear__list_issues", "completed"),
          toolEvent("other-1", "mcp__github__create_issue", "completed"),
          toolEvent("failed-1", save, "failed"),
          toolEvent("write-1", save, "completed"),
          toolEvent("write-1", save, "completed"),
          toolEvent("write-2", "linear.save_issue", "completed"),
        ]),
      ).toBe(2);
    }),
  );
});
