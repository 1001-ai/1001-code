import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  ProjectId,
  WS_METHODS,
  WsRpcGroup,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as RpcTest from "effect/rpc/RpcTest";

import * as RpcAuthorization from "../auth/RpcAuthorization.ts";

const group = WsRpcGroup.omit(
  ...[...WsRpcGroup.requests.keys()].filter(
    (
      tag,
    ): tag is Exclude<
      keyof typeof RpcAuthorization.RPC_REQUIRED_SCOPES,
      typeof WS_METHODS.inboxAgentOpen
    > => tag !== WS_METHODS.inboxAgentOpen,
  ),
);

const clientWith = (scopes: Parameters<typeof RpcAuthorization.layer>[0], handled: Array<string>) =>
  RpcTest.makeClient(group).pipe(
    Effect.provide(
      Layer.mergeAll(
        group.toLayerHandler(WS_METHODS.inboxAgentOpen, () =>
          Effect.sync(() => {
            handled.push("open");
            return { status: "unavailable" as const, message: "No Claude." };
          }),
        ),
        RpcAuthorization.layer(scopes),
      ),
    ),
  );

it.effect(
  "lets only an operator open a project's Inbox, since the first open makes its thread",
  () =>
    Effect.gen(function* () {
      const handled: Array<string> = [];
      const reader = yield* clientWith([AuthOrchestrationReadScope], handled);
      expect(
        yield* reader[WS_METHODS.inboxAgentOpen]({
          projectId: ProjectId.make("project-acme"),
        }).pipe(Effect.flip),
      ).toMatchObject({ requiredPermission: AuthOrchestrationOperateScope });
      expect(handled).toEqual([]);

      const operator = yield* clientWith(
        [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
        handled,
      );
      yield* operator[WS_METHODS.inboxAgentOpen]({ projectId: ProjectId.make("project-acme") });
      expect(handled).toEqual(["open"]);
    }).pipe(Effect.scoped),
);
