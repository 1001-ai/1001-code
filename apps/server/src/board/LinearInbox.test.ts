import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  type OrchestrationV2ThreadShell,
  type TeamCatalogSnapshot,
} from "@t3tools/contracts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import { expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as TeamCatalog from "../teamCatalog/TeamCatalog.ts";
import * as Board from "./Board.ts";
import * as LinearInbox from "./LinearInbox.ts";
import type { InboxData } from "./linearInboxRouting.ts";

const ME = "user-me";

const entry = (key: string, team: string | null) => ({
  file: `projects/${key}.json`,
  project: {
    key,
    name: key,
    repo: `github.com/acme/${key}`,
    owners: [],
    ...(team === null ? {} : { linear: { team } }),
  },
  cloneUrl: `git@github.com:acme/${key}.git`,
  checkout: { path: `/projects/${key}`, state: "present" as const },
  reachable: null,
});

const catalog: TeamCatalogSnapshot = {
  source: "git@github.com:acme/catalog.git",
  defaultSource: null,
  revision: "abc",
  fetchedAt: null,
  refreshing: false,
  error: null,
  projects: [entry("web", "COD"), entry("api", "COD"), entry("docs", null)],
  invalid: [],
  viewer: { login: null, problem: null },
};

const answer = (createdAt: string): InboxData => ({
  teams: { nodes: [{ members: { nodes: [{ id: ME }, { id: "user-lawrence" }] } }] },
  comments: {
    nodes: [
      {
        id: "comment-1",
        body: "agent: proposal",
        createdAt,
        user: { id: "user-lawrence", name: "Lawrence Smith", displayName: "Lawrence" },
        botActor: null,
        externalUser: null,
        issue: {
          identifier: "COD-2",
          state: { type: "started" },
          attachments: {
            nodes: [
              {
                url: "t3-thread://v2/env-me/thread-mine",
                createdAt: "1970-01-01T00:00:00.000Z",
                creator: { id: ME },
              },
            ],
          },
        },
      },
    ],
    pageInfo: { hasNextPage: false },
  },
});

it.effect(
  "starts each team now, reads only newer comments, and keeps its place over restarts",
  () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-linear-inbox-" });
      const calls: Array<Record<string, unknown>> = [];
      const logs: Array<unknown> = [];
      const layer = LinearInbox.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(Board.Board)({
              connection: Effect.succeed({
                status: "connected",
                viewer: { id: ME, name: "Mohammed", email: "m@example.test", workspace: "Acme" },
              }),
              query: ((_query: string, variables: Record<string, unknown>) =>
                Effect.sync(() => {
                  calls.push(variables);
                  return answer("2026-11-15T12:00:00.000Z");
                })) as Board.Board["Service"]["query"],
            }),
            Layer.mock(TeamCatalog.TeamCatalog)({ snapshot: Effect.succeed(catalog) }),
            Layer.mock(Orchestrator.OrchestratorV2)({
              getThreadShell: (threadId) =>
                Effect.succeed(
                  threadId === "thread-mine"
                    ? ({
                        providerInstanceId: "claude",
                        updatedAt: DateTime.makeUnsafe(0),
                        archivedAt: null,
                      } as unknown as OrchestrationV2ThreadShell)
                    : null,
                ),
            }),
            Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
              getInstance: () => Effect.succeed({ driverKind: "claudeAgent" } as ProviderInstance),
            }),
            Layer.mock(ServerEnvironment.ServerEnvironment)({
              getEnvironmentId: Effect.succeed(EnvironmentId.make("env-me")),
            }),
            ServerConfig.layerTest(process.cwd(), baseDir),
          ),
        ),
      );
      const logger = Logger.layer(
        [Logger.make(({ logLevel, message }) => logLevel === "Info" && logs.push(message))],
        { mergeWithExisting: false },
      );
      const poll = LinearInbox.LinearInbox.pipe(
        Effect.flatMap((inbox) => inbox.poll),
        Effect.provide(Layer.merge(layer, logger)),
      );

      yield* poll;
      expect(calls).toEqual([]);
      const config = yield* ServerConfig.ServerConfig.pipe(
        Effect.provide(ServerConfig.layerTest(process.cwd(), baseDir)),
      );
      const cursorPath = path.join(config.stateDir, "linear-inbox.json");
      expect(JSON.parse(yield* fileSystem.readFileString(cursorPath))).toEqual({
        COD: "1970-01-01T00:00:00.000Z",
      });

      yield* poll;
      expect(calls).toEqual([{ key: "COD", since: "1970-01-01T00:00:00.000Z", first: 100 }]);
      expect(logs).toEqual([
        [
          "Linear inbox would deliver a comment.",
          {
            comment: "comment-1",
            issue: "COD-2",
            threadId: "thread-mine",
            kind: "agent",
            sender: "Lawrence",
          },
        ],
      ]);

      yield* poll;
      expect(calls.at(-1)).toEqual({ key: "COD", since: "2026-11-15T12:00:00.000Z", first: 100 });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
