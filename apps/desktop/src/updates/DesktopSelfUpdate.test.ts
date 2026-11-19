import { assert, describe, it } from "@effect/vitest";
import type { DesktopSelfUpdateState } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Scope from "effect/Scope";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import type * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopIpc from "../ipc/DesktopIpc.ts";
import * as DesktopShellEnvironment from "../shell/DesktopShellEnvironment.ts";
import * as DesktopSelfUpdate from "./DesktopSelfUpdate.ts";

const COMMAND = ["/opt/tools/update", "code", "update"];
const SETTING = JSON.stringify(COMMAND);
const textEncoder = new TextEncoder();

type Flag = "--check" | "--stage" | "--finish";
type Reply = Effect.Effect<ChildProcessSpawner.ChildProcessHandle, PlatformError.PlatformError>;

interface Spawned {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly options: ChildProcess.CommandOptions;
}

const bytes = (text: string) =>
  text === "" ? Stream.empty : Stream.make(textEncoder.encode(text));

function exited(stdout: string, exitCode = 0, stderr = ""): Reply {
  return Effect.succeed(
    ChildProcessSpawner.makeHandle({
      pid: ChildProcessSpawner.ProcessId(1),
      stdout: bytes(stdout),
      stderr: bytes(stderr),
      all: Stream.empty,
      exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
      isRunning: Effect.succeed(false),
      kill: () => Effect.void,
      stdin: Sink.drain,
      getInputFd: () => Sink.drain,
      getOutputFd: () => Stream.empty,
      unref: Effect.succeed(Effect.void),
    }),
  );
}

/** Runs until `answer` completes, then prints its line and exits 0. */
function pending(answer: Deferred.Deferred<string>): Reply {
  return Effect.succeed(
    ChildProcessSpawner.makeHandle({
      pid: ChildProcessSpawner.ProcessId(2),
      stdout: Stream.fromEffect(Deferred.await(answer)).pipe(
        Stream.map((line) => textEncoder.encode(line)),
      ),
      stderr: Stream.empty,
      all: Stream.empty,
      exitCode: Deferred.await(answer).pipe(Effect.as(ChildProcessSpawner.ExitCode(0))),
      isRunning: Effect.succeed(true),
      kill: () => Effect.void,
      stdin: Sink.drain,
      getInputFd: () => Sink.drain,
      getOutputFd: () => Stream.empty,
      unref: Effect.succeed(Effect.void),
    }),
  );
}

const spawnFailure = PlatformError.systemError({
  _tag: "NotFound",
  module: "ChildProcess",
  method: "spawn",
  pathOrDescriptor: COMMAND[0]!,
});

function makeHarness(input: {
  readonly setting?: string | undefined;
  readonly reply: (flag: Flag) => Reply;
  readonly onState?: (state: DesktopSelfUpdateState) => Effect.Effect<unknown>;
}) {
  const spawned: Spawned[] = [];
  const sent: DesktopSelfUpdateState[] = [];
  const events: string[] = [];

  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      const standard = command as ChildProcess.StandardCommand;
      const args = standard.args.map(String);
      spawned.push({ command: standard.command, args, options: standard.options });
      const flag = args.at(-1) as Flag;
      // The real spawner stops the child when its scope closes.
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          events.push(`closed ${flag}`);
        }),
      );
      const handle = yield* input.reply(flag);
      return ChildProcessSpawner.makeHandle({
        ...handle,
        unref: Effect.sync(() => {
          events.push(`unref ${flag}`);
          return Effect.void;
        }),
      });
    }),
  );

  const layer = DesktopSelfUpdate.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Layer.mock(ElectronApp.ElectronApp, {
          quit: Effect.sync(() => {
            events.push("quit");
          }),
        }),
        Layer.mock(ElectronWindow.ElectronWindow, {
          sendAll: (_channel, state) =>
            Effect.sync(() => {
              sent.push(state as DesktopSelfUpdateState);
            }).pipe(
              Effect.andThen(input.onState?.(state as DesktopSelfUpdateState) ?? Effect.void),
            ),
        }),
        DesktopIpc.layerTest({
          removeHandler: () => {},
          handle: () => {},
          removeAllListeners: () => {},
          on: () => {},
        }),
        Layer.mock(DesktopShellEnvironment.DesktopShellEnvironment, {
          awaitDiscovery: Effect.succeed(true),
        }),
        Path.layer,
      ),
    ),
  );

  const start = Effect.gen(function* () {
    const service = yield* DesktopSelfUpdate.DesktopSelfUpdate;
    yield* service.start.pipe(
      Effect.provideService(
        HostProcess.Environment,
        input.setting === undefined ? {} : { T3CODE_UPDATE_COMMAND: input.setting },
      ),
    );
    return service;
  });

  const flags = () => spawned.map(({ args }) => args.at(-1));
  return { layer, start, spawned, sent, events, flags };
}

const statuses = (states: ReadonlyArray<DesktopSelfUpdateState>) =>
  states.map((state) => state.status);

describe("DesktopSelfUpdate", () => {
  it.effect.each([
    { name: "unset", setting: undefined },
    { name: "not JSON", setting: "/opt/tools/update code update" },
    { name: "an empty array", setting: "[]" },
    { name: "a relative executable", setting: '["tools/update","code"]' },
    { name: "not all strings", setting: '["/opt/tools/update",1]' },
  ])("stays off when the setting is $name", ({ setting }) => {
    const harness = makeHarness({ setting, reply: () => exited('{"update": true}') });
    return Effect.gen(function* () {
      const service = yield* harness.start;
      yield* TestClock.adjust("3 hours");
      assert.isFalse(yield* service.enabled);
      assert.deepEqual(yield* service.checkNow, { status: "off" });
      assert.deepEqual(harness.spawned, []);
      assert.deepEqual(yield* service.getState, { status: "idle" });
      assert.isFalse(yield* service.restartToUpdate);
      assert.deepEqual(harness.events, []);
    }).pipe(Effect.scoped, Effect.provide(harness.layer));
  });

  it.effect(
    "checks shortly after startup, builds the update, and stops checking once ready",
    () => {
      const harness = makeHarness({
        setting: SETTING,
        reply: (flag) => exited(flag === "--check" ? '{"update": true}\n' : '{"staged": true}\n'),
      });
      return Effect.gen(function* () {
        const service = yield* harness.start;
        yield* TestClock.adjust("29 seconds");
        assert.deepEqual(harness.spawned, []);

        yield* TestClock.adjust("1 second");
        assert.deepEqual(
          harness.spawned.map(({ command, args }) => [command, ...args]),
          [
            [...COMMAND, "--check"],
            [...COMMAND, "--stage"],
          ],
        );
        assert.deepEqual(statuses(harness.sent), ["building", "ready"]);
        assert.deepEqual(yield* service.getState, { status: "ready" });

        yield* TestClock.adjust("3 hours");
        assert.deepEqual(harness.flags(), ["--check", "--stage"]);
      }).pipe(Effect.scoped, Effect.provide(harness.layer));
    },
  );

  it.effect.each([
    { name: "no update exists", check: '{"update": false}', stage: "", flags: ["--check"] },
    {
      name: "the build is already current",
      check: '{"update": true}',
      stage: '{"staged": false}',
      flags: ["--check", "--stage"],
    },
  ])("stays idle and checks again an hour later when $name", ({ check, stage, flags }) => {
    const harness = makeHarness({
      setting: SETTING,
      reply: (flag) => exited(flag === "--check" ? check : stage),
    });
    return Effect.gen(function* () {
      const service = yield* harness.start;
      yield* TestClock.adjust("30 seconds");
      assert.deepEqual(harness.flags(), flags);
      assert.deepEqual(yield* service.getState, { status: "idle" });

      yield* TestClock.adjust("1 hour");
      assert.deepEqual(harness.flags(), [...flags, ...flags]);
    }).pipe(Effect.scoped, Effect.provide(harness.layer));
  });

  it.effect.each([
    {
      name: "the check exits non-zero",
      reply: (flag: Flag) =>
        flag === "--check"
          ? exited("", 1, "\u001b[31mAnother update is running.\u001b[0m\n")
          : exited(""),
      message: "Could not check for an update: Another update is running.",
    },
    {
      name: "the check prints something else",
      reply: (flag: Flag) => (flag === "--check" ? exited("Checking...\nyes\n") : exited("")),
      message: "Could not check for an update: the update command's answer was not understood.",
    },
    {
      name: "the command cannot be started",
      reply: () => Effect.fail(spawnFailure),
      message: "Could not check for an update: the update command did not run.",
    },
    {
      name: "the build fails",
      reply: (flag: Flag) => (flag === "--check" ? exited('{"update": true}') : exited("", 2)),
      message: "Could not build the update: the update command exited with code 2.",
    },
  ])("reports an error when $name and tries again on the next check", ({ reply, message }) => {
    let failing = true;
    const harness = makeHarness({
      setting: SETTING,
      reply: (flag) =>
        failing
          ? reply(flag)
          : exited(flag === "--check" ? '{"update": true}' : '{"staged": true}'),
    });
    return Effect.gen(function* () {
      const service = yield* harness.start;
      yield* TestClock.adjust("30 seconds");
      assert.deepEqual(yield* service.getState, { status: "error", message });
      assert.deepEqual(harness.sent.at(-1), { status: "error", message });

      failing = false;
      yield* TestClock.adjust("1 hour");
      assert.deepEqual(yield* service.getState, { status: "ready" });
    }).pipe(Effect.scoped, Effect.provide(harness.layer));
  });

  it.effect("reports a check that never answers as an error", () => {
    const harness = makeHarness({
      setting: SETTING,
      reply: () => Deferred.make<string>().pipe(Effect.flatMap(pending)),
    });
    return Effect.gen(function* () {
      const service = yield* harness.start;
      yield* TestClock.adjust("30 seconds");
      yield* TestClock.adjust("5 minutes");
      assert.deepEqual(yield* service.getState, {
        status: "error",
        message: "Could not check for an update: the update command took too long.",
      });
      assert.include(harness.events, "closed --check");
    }).pipe(Effect.scoped, Effect.provide(harness.layer));
  });

  it.effect("starts no check while a build is still running", () =>
    Effect.gen(function* () {
      const stageAnswer = yield* Deferred.make<string>();
      const harness = makeHarness({
        setting: SETTING,
        reply: (flag) => (flag === "--check" ? exited('{"update": true}') : pending(stageAnswer)),
      });
      yield* Effect.gen(function* () {
        const service = yield* harness.start;
        yield* TestClock.adjust("30 seconds");
        assert.deepEqual(yield* service.getState, { status: "building" });

        yield* TestClock.adjust("1 hour");
        assert.deepEqual(harness.flags(), ["--check", "--stage"]);

        yield* Deferred.succeed(stageAnswer, '{"staged": false}');
        yield* TestClock.adjust("1 hour");
        assert.deepEqual(harness.flags(), ["--check", "--stage", "--check", "--stage"]);
      }).pipe(Effect.scoped, Effect.provide(harness.layer));
    }),
  );

  it.effect("stops a running build when the app quits", () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        setting: SETTING,
        reply: (flag) =>
          flag === "--check"
            ? exited('{"update": true}')
            : Deferred.make<string>().pipe(Effect.flatMap(pending)),
      });
      const appScope = yield* Scope.make();
      yield* Effect.gen(function* () {
        yield* harness.start.pipe(Scope.provide(appScope));
        yield* TestClock.adjust("30 seconds");
        assert.notInclude(harness.events, "closed --stage");

        yield* Scope.close(appScope, Exit.void);
        assert.include(harness.events, "closed --stage");
      }).pipe(Effect.scoped, Effect.provide(harness.layer));
    }),
  );

  it.effect.each<{
    name: string;
    reply: Reply;
    result: DesktopSelfUpdate.DesktopSelfUpdateCheckResult;
    state: DesktopSelfUpdateState;
  }>([
    {
      name: "no update exists",
      reply: exited('{"update": false}'),
      result: { status: "up-to-date" },
      state: { status: "idle" },
    },
    {
      name: "the check fails",
      reply: exited("", 1, "Another update is running.\n"),
      result: {
        status: "error",
        message: "Could not check for an update: Another update is running.",
      },
      state: {
        status: "error",
        message: "Could not check for an update: Another update is running.",
      },
    },
  ])("checks on request and can check again when $name", ({ reply, result, state }) => {
    const harness = makeHarness({ setting: SETTING, reply: () => reply });
    return Effect.gen(function* () {
      const service = yield* harness.start;
      assert.isTrue(yield* service.enabled);
      assert.deepEqual(yield* service.checkNow, result);
      assert.deepEqual(yield* service.getState, state);
      assert.deepEqual(yield* service.checkNow, result);
      assert.deepEqual(harness.flags(), ["--check", "--check"]);
    }).pipe(Effect.scoped, Effect.provide(harness.layer));
  });

  it.effect("builds an update found on request in the background, then offers it", () =>
    Effect.gen(function* () {
      const stageAnswer = yield* Deferred.make<string>();
      const ready = yield* Deferred.make<void>();
      const harness = makeHarness({
        setting: SETTING,
        reply: (flag) => (flag === "--check" ? exited('{"update": true}') : pending(stageAnswer)),
        onState: (state) =>
          state.status === "ready" ? Deferred.succeed(ready, undefined) : Effect.void,
      });
      yield* Effect.gen(function* () {
        const service = yield* harness.start;
        assert.deepEqual(yield* service.checkNow, { status: "started" });
        assert.deepEqual(yield* service.getState, { status: "building" });
        assert.deepEqual(yield* service.checkNow, { status: "building" });

        yield* Deferred.succeed(stageAnswer, '{"staged": true}');
        yield* Deferred.await(ready);
        assert.deepEqual(yield* service.checkNow, { status: "ready" });
        assert.deepEqual(harness.flags(), ["--check", "--stage"]);
        assert.deepEqual(statuses(harness.sent), ["building", "ready"]);
      }).pipe(Effect.scoped, Effect.provide(harness.layer));
    }),
  );

  it.effect("says a scheduled check is already running instead of starting another", () =>
    Effect.gen(function* () {
      const checkAnswer = yield* Deferred.make<string>();
      const harness = makeHarness({ setting: SETTING, reply: () => pending(checkAnswer) });
      yield* Effect.gen(function* () {
        const service = yield* harness.start;
        yield* TestClock.adjust("30 seconds");
        assert.deepEqual(yield* service.checkNow, { status: "checking" });
        assert.deepEqual(harness.flags(), ["--check"]);
      }).pipe(Effect.scoped, Effect.provide(harness.layer));
    }),
  );

  it.effect("restarts to update only once a build is ready", () => {
    const harness = makeHarness({
      setting: SETTING,
      reply: (flag) => exited(flag === "--check" ? '{"update": true}' : '{"staged": true}'),
    });
    return Effect.gen(function* () {
      const service = yield* harness.start;
      assert.isFalse(yield* service.restartToUpdate);
      assert.deepEqual(harness.events, []);

      yield* TestClock.adjust("30 seconds");
      assert.isTrue(yield* service.restartToUpdate);
      const finish = harness.spawned.at(-1);
      assert.deepEqual(finish && [finish.command, ...finish.args], [...COMMAND, "--finish"]);
      assert.deepInclude(finish?.options, {
        detached: true,
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      });
      assert.deepEqual(harness.events.slice(-3), ["unref --finish", "closed --finish", "quit"]);

      assert.isFalse(yield* service.restartToUpdate);
      assert.deepEqual(harness.flags(), ["--check", "--stage", "--finish"]);
    }).pipe(Effect.scoped, Effect.provide(harness.layer));
  });

  it.effect("keeps the update ready to retry when the finish step cannot start", () => {
    let failing = true;
    const harness = makeHarness({
      setting: SETTING,
      reply: (flag) =>
        flag === "--finish"
          ? failing
            ? Effect.fail(spawnFailure)
            : exited("")
          : exited(flag === "--check" ? '{"update": true}' : '{"staged": true}'),
    });
    return Effect.gen(function* () {
      const service = yield* harness.start;
      yield* TestClock.adjust("30 seconds");
      assert.isFalse(yield* service.restartToUpdate);
      assert.notInclude(harness.events, "quit");
      const failed = {
        status: "ready",
        restartError: "Could not start the update: the update command did not run.",
      } as const;
      assert.deepEqual(yield* service.getState, failed);
      assert.deepEqual(harness.sent.at(-1), failed);

      // The staged build is still there, so no check or build runs again.
      yield* TestClock.adjust("1 hour");
      assert.deepEqual(harness.flags(), ["--check", "--stage", "--finish"]);

      failing = false;
      assert.isTrue(yield* service.restartToUpdate);
      assert.deepEqual(harness.flags(), ["--check", "--stage", "--finish", "--finish"]);
      assert.include(harness.events, "quit");
    }).pipe(Effect.scoped, Effect.provide(harness.layer));
  });
});
