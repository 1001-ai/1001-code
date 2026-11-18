import { assert, describe, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  type ModelSelection,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

const at = (second: number) => DateTime.makeUnsafe(Date.UTC(2026, 10, 14, 12, 0, second));
const card = (id: string) => `Two choices.\n\n> **${id} · Ship it?**\n>\n> - Yes\n> - No`;
const withdraw = (id: string) =>
  `You chose CSV, so one question is moot.\n\n${id}: no longer needed`;

type Message = {
  readonly role: "user" | "assistant";
  readonly createdBy: "user" | "agent";
  readonly text: string;
  readonly second: number;
  readonly finished?: number;
  readonly streaming?: boolean;
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
const assistant = (second: number, text: string, streaming = false): Message => ({
  role: "assistant",
  createdBy: "agent",
  text,
  second,
  streaming,
});

const cases: ReadonlyArray<readonly [string, ReadonlyArray<Message>, number | null]> = [
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
    "a withdrawal still streaming",
    [user(1), assistant(2, card("Q1")), assistant(3, withdraw("Q1"), true)],
    2,
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

describe("thread shell openQuestionsAt", () => {
  it.layer(layerTest)((it) => {
    it.effect.each(cases)("stored and in-memory shells agree on %s", ([name, messages, expected]) =>
      Effect.gen(function* () {
        const store = yield* ProjectionStore.ProjectionStoreV2;
        const key = name.replaceAll(/\W+/g, "-");
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
              runId: null,
              nodeId: null,
              role: message.role,
              text: message.text,
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
        const want = expected === null ? null : at(expected);
        assert.deepEqual(stored?.openQuestionsAt, want);
        assert.deepEqual(inMemory.openQuestionsAt, want);
      }),
    );
  });
});
