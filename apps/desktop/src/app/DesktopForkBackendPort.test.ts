import { assert, it } from "@effect/vitest";
import { FORK_DESKTOP } from "@t3tools/contracts";
import * as NetService from "@t3tools/shared/Net";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import { vi } from "vite-plus/test";

vi.mock("electron", () => ({}));
vi.mock("@clerk/electron", () => ({ createClerkBridge: vi.fn() }));
vi.mock("@clerk/electron/storage", () => ({ storage: vi.fn() }));

import * as DesktopApp from "./DesktopApp.ts";

const resolveWith = (portIsFree: boolean) => {
  const probed: number[] = [];
  const net = {
    canListenOnHost: (port: number) =>
      Effect.sync(() => {
        probed.push(port);
        return portIsFree;
      }),
  } as unknown as NetService.NetService["Service"];
  return DesktopApp.resolveDesktopBackendPort(Option.none()).pipe(
    Effect.provideService(NetService.NetService, net),
    Effect.exit,
    Effect.map((exit) => ({ exit, probed })),
  );
};

it.effect("listens on the fixed port and refuses to start when it is taken", () =>
  Effect.gen(function* () {
    const free = yield* resolveWith(true);
    assert.deepEqual(
      free.exit,
      Exit.succeed({ port: FORK_DESKTOP.backendPort, selectedByScan: true }),
    );

    const taken = yield* resolveWith(false);
    assert.isTrue(Exit.isFailure(taken.exit));
    assert.deepEqual(taken.probed, [FORK_DESKTOP.backendPort]);
  }),
);
