import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  INBOX_NOT_READY_HINT,
  MESSAGE_FROM_INBOX_ITEM_ID,
  MIXED_PROJECTS_HINT,
  planMessageFromInbox,
  withMessageFromInboxItem,
} from "./messageFromInbox.logic";

const LOCAL = EnvironmentId.make("env-local");
const REMOTE = EnvironmentId.make("env-remote");
const ACME = ProjectId.make("project-acme");
const OTHER = ProjectId.make("project-other");

const shell = (id: string, fields: Record<string, unknown> = {}) =>
  ({
    id: ThreadId.make(id),
    projectId: ACME,
    title: "Inbox",
    createdBy: "system",
    creationSource: "server",
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: ThreadId.make(id) },
    createdAt: DateTime.makeUnsafe(1_000),
    activeRunId: null,
    activityRunStatus: null,
    pendingRuntimeRequest: null,
    openQuestionsAt: null,
    ...fields,
  }) as never;

const selected = (id: string, title: string, projectId = ACME, environmentId = LOCAL) => ({
  environmentId,
  projectId,
  id: ThreadId.make(id),
  title,
});

const environments = new Map([
  [LOCAL, [shell("inbox-acme"), shell("inbox-other", { projectId: OTHER })]],
  [REMOTE, [shell("inbox-remote")]],
]);
const threadsOf = (environmentId: EnvironmentId) => environments.get(environmentId) ?? [];

describe("planMessageFromInbox", () => {
  it("sends one project's threads to its Inbox, without the Inbox itself", () => {
    const plan = planMessageFromInbox(
      [
        selected("sign-in", "Sign-in page"),
        selected("inbox-other", "Inbox", OTHER),
        selected("toolbar", "Toolbar overlap"),
      ],
      threadsOf,
    );
    expect(plan).toMatchObject({
      inbox: { environmentId: LOCAL, threadId: "inbox-acme" },
      recipients: [
        { kind: "thread", environmentId: LOCAL, threadId: "sign-in", title: "Sign-in page" },
        { kind: "thread", environmentId: LOCAL, threadId: "toolbar", title: "Toolbar overlap" },
      ],
    });
  });

  it("asks for one project when the selection spans projects or environments", () => {
    for (const other of [selected("b", "B", OTHER), selected("b", "B", ACME, REMOTE)]) {
      expect(planMessageFromInbox([selected("a", "A"), other], threadsOf)).toEqual({
        inbox: null,
        disabledReason: MIXED_PROJECTS_HINT,
      });
    }
  });

  it("waits for a project whose Inbox the server has not made", () => {
    expect(
      planMessageFromInbox([selected("a", "A", ProjectId.make("project-new"))], threadsOf),
    ).toEqual({ inbox: null, disabledReason: INBOX_NOT_READY_HINT });
  });

  it("offers nothing when only an Inbox is selected", () => {
    expect(planMessageFromInbox([selected("inbox-acme", "Inbox")], threadsOf)).toBeNull();
  });
});

describe("withMessageFromInboxItem", () => {
  const items = [{ id: "settle" }, { id: "delete" }].map((item) => ({
    ...item,
    label: item.id,
  }));

  it("puts the item first, separated from the rest, and disabled with its reason", () => {
    expect(
      withMessageFromInboxItem({ inbox: null, disabledReason: MIXED_PROJECTS_HINT }, items),
    ).toEqual([
      {
        id: MESSAGE_FROM_INBOX_ITEM_ID,
        label: "Message from Inbox…",
        disabled: true,
        detail: MIXED_PROJECTS_HINT,
      },
      { id: "settle", label: "settle", separatorBefore: true },
      { id: "delete", label: "delete" },
    ]);
    expect(withMessageFromInboxItem(null, items)).toEqual(items);
  });
});
