import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import {
  type LinearComment,
  commentKind,
  routeComment,
  threadSkipReason,
} from "./linearInboxRouting.ts";

const ME = "user-me";
const LAWRENCE = "user-lawrence";
const ENVIRONMENT = EnvironmentId.make("env-me");
const context = { viewerId: ME, environmentId: ENVIRONMENT, memberIds: new Set([ME, LAWRENCE]) };

const link = (
  url: string,
  creator: string | null = ME,
  createdAt = "2026-11-15T10:00:00.000Z",
) => ({ url, createdAt, creator: creator === null ? null : { id: creator } });

const comment = (fields: Partial<LinearComment> = {}): LinearComment => ({
  id: "comment-1",
  body: "agent: proposal — you take the poll fiber, I take the cursor.",
  createdAt: "2026-11-15T12:00:00.000Z",
  user: { id: LAWRENCE, name: "Lawrence Smith", displayName: "Lawrence" },
  botActor: null,
  externalUser: null,
  issue: {
    identifier: "COD-2",
    state: { type: "started" },
    attachments: { nodes: [link("t3-thread://v2/env-me/thread-mine")] },
  },
  ...fields,
});

const issueWith = (fields: Partial<NonNullable<LinearComment["issue"]>>) => ({
  ...comment().issue!,
  ...fields,
});

describe("routeComment", () => {
  it.each([
    ["a teammate's agent", comment(), "thread"],
    ["a comment on a project update", comment({ issue: null }), "not-on-an-issue"],
    ["an integration", comment({ botActor: { id: "bot-github" } }), "not-a-person"],
    ["a guest from outside", comment({ externalUser: { id: "external-1" } }), "not-a-person"],
    ["a deleted user", comment({ user: null }), "not-a-person"],
    [
      "my own comment",
      comment({ user: { id: ME, name: "Mohammed", displayName: "Mohammed" } }),
      "own-comment",
    ],
    [
      "someone outside the team",
      comment({ user: { id: "user-x", name: "X", displayName: "X" } }),
      "not-a-team-member",
    ],
    [
      "an issue not in progress",
      comment({ issue: issueWith({ state: { type: "unstarted" } }) }),
      "issue-not-started",
    ],
    [
      "a thread link someone else attached",
      comment({
        issue: issueWith({
          attachments: { nodes: [link("t3-thread://v2/env-me/thread-mine", LAWRENCE)] },
        }),
      }),
      "no-thread-link",
    ],
    [
      "a thread on another machine",
      comment({
        issue: issueWith({ attachments: { nodes: [link("t3-thread://v2/env-other/thread-x")] } }),
      }),
      "no-thread-link",
    ],
    [
      "a link without its machine",
      comment({ issue: issueWith({ attachments: { nodes: [link("t3-thread://v1/thread-x")] } }) }),
      "no-thread-link",
    ],
  ])("%s", (_name, input, expected) => {
    const route = routeComment(input, context);
    expect(route._tag === "thread" ? "thread" : route.reason).toBe(expected);
  });

  it("names the sender, tells agents from people, and takes my newest link", () => {
    const route = routeComment(
      comment({
        body: "  Agent: counter",
        issue: issueWith({
          attachments: {
            nodes: [
              link("t3-thread://v2/env-me/thread-old", ME, "2026-11-15T09:00:00.000Z"),
              link("https://github.com/acme/web/pull/1"),
              link("t3-thread://v2/env-me/thread-new", ME, "2026-11-15T11:00:00.000Z"),
              link("t3-thread://v2/env-me/thread-forged", LAWRENCE, "2026-11-15T11:30:00.000Z"),
            ],
          },
        }),
      }),
      context,
    );
    expect(route).toEqual({
      _tag: "thread",
      threadId: "thread-new",
      kind: "agent",
      sender: "Lawrence",
    });
    expect(commentKind("Let's keep the poll in Board.ts. agent: no")).toBe("person");
  });
});

describe("threadSkipReason", () => {
  const now = DateTime.makeUnsafe("2026-11-15T12:00:00.000Z");
  const thread = (fields: { updatedAt?: string; archivedAt?: string | null } = {}) => ({
    updatedAt: DateTime.makeUnsafe(fields.updatedAt ?? "2026-11-14T12:00:00.000Z"),
    archivedAt:
      fields.archivedAt === undefined || fields.archivedAt === null
        ? null
        : DateTime.makeUnsafe(fields.archivedAt),
  });

  it.each([
    ["an active Claude thread", thread(), "claudeAgent", null],
    ["an active Codex thread", thread(), "codex", null],
    ["a deleted thread", null, "claudeAgent", "thread-missing"],
    [
      "an archived thread",
      thread({ archivedAt: "2026-11-15T00:00:00.000Z" }),
      "claudeAgent",
      "thread-archived",
    ],
    ["a Cursor thread", thread(), "cursor", "provider-not-supported"],
    ["a removed provider", thread(), undefined, "provider-not-supported"],
    [
      "a thread idle for over a week",
      thread({ updatedAt: "2026-11-07T11:00:00.000Z" }),
      "codex",
      "thread-inactive",
    ],
  ])("%s", (_name, input, driver, expected) => {
    expect(threadSkipReason(input, driver, now.epochMilliseconds)).toBe(expected);
  });
});
