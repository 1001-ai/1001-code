import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  ProjectId,
  ThreadId,
  WS_METHODS,
  WsRpcGroup,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as RpcTest from "effect/rpc/RpcTest";

import * as RpcAuthorization from "../auth/RpcAuthorization.ts";

const PROJECT = ProjectId.make("project-acme");

const group = WsRpcGroup.omit(
  ...[...WsRpcGroup.requests.keys()].filter(
    (
      tag,
    ): tag is Exclude<
      keyof typeof RpcAuthorization.RPC_REQUIRED_SCOPES,
      typeof WS_METHODS.inboxAgentReset
    > => tag !== WS_METHODS.inboxAgentReset,
  ),
);

const clientWith = (scopes: Parameters<typeof RpcAuthorization.layer>[0], handled: Array<string>) =>
  RpcTest.makeClient(group).pipe(
    Effect.provide(
      Layer.mergeAll(
        group.toLayerHandler(WS_METHODS.inboxAgentReset, () =>
          Effect.sync(() => {
            handled.push("reset");
            return {
              threadId: ThreadId.make("inbox-new"),
              previousThreadId: ThreadId.make("inbox-old"),
            };
          }),
        ),
        RpcAuthorization.layer(scopes),
      ),
    ),
  );

it.effect("requires orchestration operate scope to reset a project's Inbox", () =>
  Effect.gen(function* () {
    const handled: Array<string> = [];
    const reader = yield* clientWith([AuthOrchestrationReadScope], handled);
    expect(
      yield* reader[WS_METHODS.inboxAgentReset]({ projectId: PROJECT }).pipe(Effect.flip),
    ).toMatchObject({
      requiredPermission: AuthOrchestrationOperateScope,
    });
    expect(handled).toEqual([]);

    const operator = yield* clientWith(
      [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
      handled,
    );
    expect(yield* operator[WS_METHODS.inboxAgentReset]({ projectId: PROJECT })).toEqual({
      threadId: ThreadId.make("inbox-new"),
      previousThreadId: ThreadId.make("inbox-old"),
    });
    expect(handled).toEqual(["reset"]);
  }).pipe(Effect.scoped),
);
