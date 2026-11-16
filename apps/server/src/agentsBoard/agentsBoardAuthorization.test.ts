import {
  AuthOrchestrationReadScope,
  AuthSettingsWriteScope,
  ProjectId,
  WS_METHODS,
  WsRpcGroup,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as RpcTest from "effect/rpc/RpcTest";

import * as RpcAuthorization from "../auth/RpcAuthorization.ts";

const AGENTS_BOARD_METHODS = [
  WS_METHODS.agentsBoardSubscribe,
  WS_METHODS.agentsBoardRefresh,
  WS_METHODS.agentsBoardSetBranch,
  WS_METHODS.agentsBoardMedia,
] as const;
type AgentsBoardMethod = (typeof AGENTS_BOARD_METHODS)[number];

const PROJECT_ID = ProjectId.make("project-web");
const UNAVAILABLE = { status: "unavailable", reason: "no-catalog" } as const;

it.effect(
  "lets a reader see the board and its media, and keeps the branch name behind settings",
  () =>
    Effect.gen(function* () {
      const group = WsRpcGroup.omit(
        ...[...WsRpcGroup.requests.keys()].filter(
          (
            tag,
          ): tag is Exclude<keyof typeof RpcAuthorization.RPC_REQUIRED_SCOPES, AgentsBoardMethod> =>
            !(AGENTS_BOARD_METHODS as ReadonlyArray<string>).includes(tag),
        ),
      );
      const handled: Array<string> = [];
      const client = yield* RpcTest.makeClient(group).pipe(
        Effect.provide(
          Layer.mergeAll(
            group.toLayerHandler(WS_METHODS.agentsBoardSubscribe, () => {
              handled.push("subscribe");
              return Stream.make(UNAVAILABLE);
            }),
            group.toLayerHandler(WS_METHODS.agentsBoardRefresh, () =>
              Effect.sync(() => {
                handled.push("refresh");
                return UNAVAILABLE;
              }),
            ),
            group.toLayerHandler(WS_METHODS.agentsBoardSetBranch, () =>
              Effect.sync(() => {
                handled.push("setBranch");
                return UNAVAILABLE;
              }),
            ),
            group.toLayerHandler(WS_METHODS.agentsBoardMedia, () =>
              Effect.sync(() => {
                handled.push("media");
                return { mimeType: "image/png" as const, base64: "" };
              }),
            ),
            RpcAuthorization.layer([AuthOrchestrationReadScope]),
          ),
        ),
      );

      yield* client[WS_METHODS.agentsBoardSubscribe]({ projectId: PROJECT_ID }).pipe(
        Stream.runDrain,
      );
      yield* client[WS_METHODS.agentsBoardRefresh]({ projectId: PROJECT_ID });
      yield* client[WS_METHODS.agentsBoardMedia]({
        projectId: PROJECT_ID,
        path: "media/sam-2/shot.png",
      });
      expect(
        yield* client[WS_METHODS.agentsBoardSetBranch]({
          projectId: PROJECT_ID,
          branch: "agent-notes",
        }).pipe(Effect.flip),
      ).toMatchObject({ requiredPermission: AuthSettingsWriteScope });
      expect(handled).toEqual(["subscribe", "refresh", "media"]);

      // A path outside `media/` never reaches the handler either: the request does not decode.
      const escaped = yield* client[WS_METHODS.agentsBoardMedia]({
        projectId: PROJECT_ID,
        path: "media/../reports/sam-2.md",
      }).pipe(Effect.exit);
      expect(escaped._tag).toBe("Failure");
      expect(handled).toEqual(["subscribe", "refresh", "media"]);
    }).pipe(Effect.scoped),
);
