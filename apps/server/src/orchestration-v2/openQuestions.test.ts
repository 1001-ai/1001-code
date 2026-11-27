import { assert, describe, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  type ModelSelection,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ScheduledTaskId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

const at = (second: number) => DateTime.makeUnsafe(Date.UTC(2026, 10, 14, 12, 0, second));
const card = (id: string) => `Two choices.\n\n> **${id} · Ship it?**\n>\n> - Yes\n> - No`;
const threeCards = ["Q1", "Q2", "Q3"].map(card).join("\n\n");
const withdraw = (id: string) =>
  `You chose CSV, so one question is moot.\n\n${id}: no longer needed`;

type Message = {
  readonly role: "user" | "assistant";
  readonly createdBy: "user" | "agent";
  readonly text: string;
  readonly second: number;
  readonly finished?: number;
  readonly streaming?: boolean;
  readonly scheduledTaskId?: ScheduledTaskId;
  readonly runId?: RunId;
};
const user = (second: number, text = "Go"): Message => ({
  role: "user",
  createdBy: "user",
  text,
  second,
});
const wake = (second: number): Message => ({
  role: "user",
  createdBy: "agent",
  text: "Background task finished.",
  second,
});
const errorInbox = ScheduledTaskId.make("scheduled-task:local-error-inbox");
const automation = (second: number): Message => ({
  ...user(second, "Investigate the error batch."),
  scheduledTaskId: errorInbox,
});
const assistant = (second: number, text: string, streaming = false): Message => ({
  role: "assistant",
  createdBy: "agent",
  text,
  second,
  streaming,
});

// The last entry is the scheduled task that started the thread, absent when a person did.
const cases: ReadonlyArray<
  readonly [string, ReadonlyArray<Message>, number | null, ScheduledTaskId?]
> = [
  ["no question", [user(1), assistant(2, "Done.")], null],
  ["a question since the user wrote", [user(1), assistant(2, card("Q1"))], 2],
  [
    "a question the user replied after",
    [user(1), assistant(2, card("Q1")), user(3, "Q1: Yes")],
    null,
  ],
  [
    "a question with wakes and later replies after it",
    [user(1), assistant(2, card("Q1")), wake(3), assistant(4, "Still checking.")],
    2,
  ],
  [
    "the newest of several questions",
    [user(1), assistant(2, card("Q1")), assistant(3, card("Q2")), assistant(4, "More.")],
    3,
  ],
  ["a question still streaming", [user(1), assistant(2, card("Q1"), true)], null],
  [
    "a question that finished after the user wrote mid-stream",
    [user(1), user(3, "Also check the docs"), { ...assistant(2, card("Q1")), finished: 4 }],
    4,
  ],
  [
    "a question that finished after the user wrote twice mid-stream",
    [
      user(1),
      user(3, "Also check the docs"),
      user(4, "And the tests"),
      { ...assistant(2, card("Q1")), finished: 5 },
    ],
    5,
  ],
  ["a quote that is not a card", [user(1), assistant(2, "> **Q1 · Ship it?**")], null],
  [
    "a question its asker withdrew",
    [user(1), assistant(2, card("Q1")), assistant(3, withdraw("Q1"))],
    null,
  ],
  [
    "one of two questions withdrawn",
    [user(1), assistant(2, `${card("Q1")}\n\n${card("Q2")}`), assistant(3, withdraw("Q1"))],
    2,
  ],
  [
    "a withdrawal that falls back to an older question",
    [user(1), assistant(2, card("Q1")), assistant(3, card("Q2")), assistant(4, withdraw("Q2"))],
    2,
  ],
  [
    "a withdrawal of a card from before the latest questions",
    [user(1), assistant(2, card("Q1")), assistant(3, card("Q2")), assistant(4, withdraw("Q1"))],
    3,
  ],
  [
    "two of three questions the user has not answered yet",
    [user(1), assistant(2, threeCards), user(3, "Q1: Yes")],
    2,
  ],
  [
    "three questions answered over two messages",
    [user(1), assistant(2, threeCards), user(3, "Q1: Yes"), user(4, "Q2: Yes\nQ3: skipped")],
    null,
  ],
  [
    "a question the user skipped beside one still open",
    [user(1), assistant(2, `${card("Q1")}\n\n${card("Q2")}`), user(3, "Q2: skipped")],
    2,
  ],
  [
    "a question the user dismissed beside one still open",
    [user(1), assistant(2, `${card("Q1")}\n\n${card("Q2")}`), user(3, "Q2: dismissed")],
    2,
  ],
  [
    "a dismissed question and an answered one",
    [
      user(1),
      assistant(2, `${card("Q1")}\n\n${card("Q2")}`),
      user(3, "Q1: dismissed"),
      user(4, "Q2: Yes"),
    ],
    null,
  ],
  [
    "a withdrawal of a re-asked question",
    [user(1), assistant(2, card("Q1")), assistant(3, card("Q1")), assistant(4, withdraw("Q1"))],
    null,
  ],
  [
    "a withdrawal still streaming",
    [user(1), assistant(2, card("Q1")), assistant(3, withdraw("Q1"), true)],
    2,
  ],
  ["an automation's first message", [automation(1), assistant(2, "Done.")], null, errorInbox],
  [
    "an automation's first message a person replied to",
    [automation(1), assistant(2, card("Q1")), user(3, "Q1: Yes")],
    null,
    errorInbox,
  ],
  [
    "an automation message in a thread a person started",
    [user(1), assistant(2, "Done."), automation(3), assistant(4, card("Q1"))],
    4,
  ],
];

const layerTest = Layer.mergeAll(
  ProjectionStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory)),
  SqlitePersistence.layerMemory,
);
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} satisfies ModelSelection;

const seedThread = (key: string, messages: ReadonlyArray<Message>) =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make(`thread:open-questions:${key}`);
    yield* store.apply({
      id: EventId.make(`event:open-questions:${key}:thread`),
      type: "thread.created",
      threadId,
      occurredAt: at(0),
      payload: {
        createdBy: "user",
        creationSource: "web",
        id: threadId,
        projectId: ProjectId.make("project:open-questions"),
        title: "Questions",
        providerInstanceId: modelSelection.instanceId,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
        forkedFrom: null,
        createdAt: at(0),
        updatedAt: at(0),
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      },
    });
    for (const [index, message] of messages.entries()) {
      yield* store.apply({
        id: EventId.make(`event:open-questions:${key}:message:${index}`),
        type: "message.updated",
        threadId,
        occurredAt: at(message.finished ?? message.second),
        payload: {
          createdBy: message.createdBy,
          creationSource: message.createdBy === "user" ? "web" : "server",
          id: MessageId.make(`message:open-questions:${key}:${index}`),
          threadId,
          runId: message.runId ?? null,
          nodeId: null,
          role: message.role,
          text: message.text,
          ...(message.scheduledTaskId === undefined
            ? {}
            : { scheduledTaskId: message.scheduledTaskId }),
          attachments: [],
          streaming: message.streaming ?? false,
          createdAt: at(message.second),
          updatedAt: at(message.finished ?? message.second),
        },
      });
    }
    const stored = (yield* store.getShellSnapshot()).threads.find(
      (thread) => thread.id === threadId,
    );
    const inMemory = ProjectionStore.threadShellFromProjection(
      yield* store.getThreadProjection(threadId),
    );
    return { stored, inMemory };
  });

describe("thread shell openQuestionsAt", () => {
  it.layer(layerTest)((it) => {
    it.effect.each(cases)("stored and in-memory shells agree on %s", (testCase) =>
      Effect.gen(function* () {
        const [name, messages, expected, startedBy] = testCase;
        const { stored, inMemory } = yield* seedThread(name.replaceAll(/\W+/g, "-"), messages);
        const want = expected === null ? null : at(expected);
        assert.deepEqual(stored?.openQuestionsAt, want);
        assert.deepEqual(inMemory.openQuestionsAt, want);
        assert.strictEqual(stored?.startedByScheduledTaskId, startedBy);
        assert.strictEqual(inMemory.startedByScheduledTaskId, startedBy);
      }),
    );
  });
});

// Each text follows a plain user message at second 1. A dismissal (no run, only `Qn: dismissed`
// lines) leaves the latest user message times at 1; anything else moves them to 2. The stored
// shell and settlement rows run the SQL form, the in-memory shell the shared TS rule.
const dismissalCases: ReadonlyArray<readonly [string, Partial<Message>, boolean]> = [
  ["Q1: dismissed", {}, true],
  ["Q45: dismissed\nQ46: dismissed", {}, true],
  ["Q10: dismissed\nQ2: dismissed\nQ300: dismissed", {}, true],
  ["Q1: dismissed", { runId: RunId.make("run:open-questions:sent") }, false],
  ["Q1: skipped", {}, false],
  ["Q1: Dismissed", {}, false],
  ["q1: dismissed", {}, false],
  [" Q1: dismissed", {}, false],
  ["Q1: dismissed\n", {}, false],
  ["Q1: dismissed\n\nQ2: dismissed", {}, false],
  ["Q1: dismissed\r\nQ2: dismissed", {}, false],
  ["Q1: dismissed\nPlease stop", {}, false],
  ["Q1: dismissed: dismissed", {}, false],
  ["Q01: dismissed", {}, false],
  ["Q1: dismissed\nQ01: dismissed", {}, false],
  ["Q1: dismissed\nQ: dismissed", {}, false],
  ["Q: dismissed", {}, false],
  ["Q1,2: dismissed", {}, false],
];

describe("question dismissals and the latest user message", () => {
  it.layer(layerTest)((it) => {
    it.effect.each(dismissalCases)("%j (%o) is a dismissal: %s", (testCase) =>
      Effect.gen(function* () {
        const [text, fields, dismissal] = testCase;
        const key = `dismissal-${dismissalCases.indexOf(testCase)}`;
        const { stored, inMemory } = yield* seedThread(key, [
          user(1),
          { ...user(2, text), ...fields },
        ]);
        const [settlement] =
          yield* (yield* ProjectionStore.ProjectionStoreV2).getSettlementCandidates(
            ThreadId.make(`thread:open-questions:${key}`),
          );
        const want = at(dismissal ? 1 : 2);
        for (const shell of [stored, inMemory]) {
          assert.deepEqual(shell?.latestUserMessageAt, want);
          assert.deepEqual(shell?.latestUserAuthoredMessageAt, want);
        }
        assert.deepEqual(settlement?.latestUserMessageAt, want);
        assert.deepEqual(settlement?.latestResumingMessageAt, want);
      }),
    );
  });
});
