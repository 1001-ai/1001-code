import {
  DesktopSelfUpdateCheckResultSchema,
  DesktopSelfUpdateStateSchema,
  type DesktopSelfUpdateCheckResult,
  type DesktopSelfUpdateState,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Fiber from "effect/Fiber";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as DesktopObservability from "../app/DesktopObservability.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopIpc from "../ipc/DesktopIpc.ts";
import * as SelfUpdateChannels from "../ipc/selfUpdateChannels.ts";
import * as DesktopShellEnvironment from "../shell/DesktopShellEnvironment.ts";

const FIRST_CHECK_DELAY = Duration.seconds(30);
const CHECK_INTERVAL = Duration.hours(1);
const CHECK_TIMEOUT = Duration.minutes(5);
const STAGE_TIMEOUT = Duration.hours(2);
const KILL_GRACE = Duration.seconds(5);
const OUTPUT_TAIL_CHARS = 2_000;

const OFF: DesktopSelfUpdateState = { status: "off" };
const IDLE: DesktopSelfUpdateState = { status: "idle" };
const BUILDING: DesktopSelfUpdateState = { status: "building" };
const READY: DesktopSelfUpdateState = { status: "ready" };

/** An absolute executable and its leading arguments; the app appends one flag. */
const UpdateCommand = Schema.fromJsonString(Schema.NonEmptyArray(Schema.String));
const decodeUpdateCommand = Schema.decodeUnknownOption(UpdateCommand);
const decodeCheckOutput = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ update: Schema.Boolean })),
);
const decodeStageOutput = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ staged: Schema.Boolean })),
);

type UpdateCommand = typeof UpdateCommand.Type;
type CheckAnswer = Deferred.Deferred<DesktopSelfUpdateCheckResult>;

const STEP_MESSAGES = {
  check: "Could not check for an update",
  stage: "Could not build the update",
  finish: "Could not start the update",
} as const;

class DesktopSelfUpdateCommandError extends Schema.TaggedError<DesktopSelfUpdateCommandError>()(
  "DesktopSelfUpdateCommandError",
  {
    step: Schema.Literals(["check", "stage", "finish"]),
    reason: Schema.Literals(["run", "exit", "output", "timeout"]),
    exitCode: Schema.optional(Schema.Number),
    /** The command's last stderr line, shown in place of the exit code when there is one. */
    stderr: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    const detail =
      this.reason === "run"
        ? "the update command did not run"
        : this.reason === "exit"
          ? this.stderr || `the update command exited with code ${this.exitCode}`
          : this.reason === "output"
            ? "the update command's answer was not understood"
            : "the update command took too long";
    return `${STEP_MESSAGES[this.step]}: ${detail.replace(/\.$/u, "")}.`;
  }
}

export class DesktopSelfUpdate extends Context.Service<
  DesktopSelfUpdate,
  {
    readonly getState: Effect.Effect<DesktopSelfUpdateState>;
    /** Serves the renderer and, when the build names an update command, checks soon and hourly. */
    readonly start: Effect.Effect<void, never, Scope.Scope>;
    /** True once `start` found an update command. */
    readonly enabled: Effect.Effect<boolean>;
    /** Checks now unless a build is ready or running; a found update builds in the background. */
    readonly checkNow: Effect.Effect<DesktopSelfUpdateCheckResult>;
    /** `checkNow`, but a check already running is waited for and its answer returned. */
    readonly checkAndWait: Effect.Effect<DesktopSelfUpdateCheckResult>;
    /** Only when `ready`: launches the command's finish step, then quits. False when it did not. */
    readonly restartToUpdate: Effect.Effect<boolean>;
  }
>()("@t3tools/desktop/updates/DesktopSelfUpdate") {}

const { logInfo, logWarning, logError } =
  DesktopObservability.makeComponentLogger("desktop-self-update");

const ANSI_ESCAPE = /\u001b\[[0-9;]*m/gu;

const lastLine = (text: string): string =>
  text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .at(-1) ?? "";

const tail = <E>(stream: Stream.Stream<Uint8Array, E>) =>
  Stream.decodeText(stream).pipe(
    Stream.runFold(
      () => "",
      (text: string, chunk: string) => (text + chunk).slice(-OUTPUT_TAIL_CHARS),
    ),
  );

const make = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const electronApp = yield* ElectronApp.ElectronApp;
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const ipc = yield* DesktopIpc.DesktopIpc;
  const shellEnvironment = yield* DesktopShellEnvironment.DesktopShellEnvironment;
  const path = yield* Path.Path;

  const stateRef = yield* Ref.make<DesktopSelfUpdateState>(OFF);
  // The scope is `start`'s, which closes on quit, so checks and builds stop with the app.
  const activeRef = yield* Ref.make(
    Option.none<{ readonly command: UpdateCommand; readonly scope: Scope.Scope }>(),
  );
  // The check answer of the cycle (a check and its build) now running; none when idle.
  const cycle = yield* Ref.make(Option.none<CheckAnswer>());
  const releaseCycle = Ref.set(cycle, Option.none());
  // The answer to fill in when this call took the cycle, else the one a running cycle fills in.
  const claimCycle = Effect.gen(function* () {
    const answer = yield* Deferred.make<DesktopSelfUpdateCheckResult>();
    return yield* Ref.modify(
      cycle,
      (
        current,
      ): readonly [{ claimed: boolean; answer: CheckAnswer }, Option.Option<CheckAnswer>] =>
        Option.isSome(current)
          ? [{ claimed: false, answer: current.value }, current]
          : [{ claimed: true, answer }, Option.some(answer)],
    );
  });
  const restarting = yield* Ref.make(false);
  // For a new holder of the cycle. `ready` is set only under the cycle, so it is stable here,
  // where a look before the claim could miss a build that finished in between.
  const releaseIfReady = Effect.fn("DesktopSelfUpdate.releaseIfReady")(function* (
    answer: CheckAnswer,
  ) {
    if ((yield* Ref.get(stateRef)).status !== "ready") return false;
    yield* releaseCycle;
    yield* Deferred.succeed(answer, { status: "ready" });
    return true;
  });

  const setState = Effect.fn("DesktopSelfUpdate.setState")(function* (
    state: DesktopSelfUpdateState,
  ) {
    yield* Ref.set(stateRef, state);
    yield* logInfo("self update state changed", { status: state.status });
    yield* electronWindow.sendAll(SelfUpdateChannels.SELF_UPDATE_STATE_CHANNEL, state);
  });

  const logFailure = (error: DesktopSelfUpdateCommandError) =>
    logError(error.message, {
      step: error.step,
      reason: error.reason,
      ...(error.cause === undefined ? {} : { cause: error.cause }),
    });

  const fail = Effect.fn("DesktopSelfUpdate.fail")(function* (
    error: DesktopSelfUpdateCommandError,
  ) {
    yield* logFailure(error);
    yield* setState({ status: "error", message: error.message });
  });

  // The command needs the login shell's PATH, which the shell environment has put in process.env.
  const run = Effect.fn("DesktopSelfUpdate.run")(function* (
    command: UpdateCommand,
    step: "check" | "stage",
    timeout: Duration.Duration,
  ) {
    const [executable, ...args] = command;
    const result = yield* Effect.scoped(
      Effect.gen(function* () {
        const child = yield* spawner.spawn(
          ChildProcess.make(executable, [...args, `--${step}`], {
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
            killSignal: "SIGTERM",
            forceKillAfter: KILL_GRACE,
          }),
        );
        return yield* Effect.all(
          { stdout: tail(child.stdout), stderr: tail(child.stderr), exitCode: child.exitCode },
          { concurrency: "unbounded" },
        );
      }),
    ).pipe(
      Effect.mapError((cause) => new DesktopSelfUpdateCommandError({ step, reason: "run", cause })),
      Effect.timeoutOption(timeout),
    );
    if (Option.isNone(result)) {
      return yield* new DesktopSelfUpdateCommandError({ step, reason: "timeout" });
    }
    const { stdout, stderr, exitCode } = result.value;
    if (exitCode !== 0) {
      return yield* new DesktopSelfUpdateCommandError({
        step,
        reason: "exit",
        exitCode,
        stderr: lastLine(stderr.replace(ANSI_ESCAPE, "")),
      });
    }
    return lastLine(stdout);
  });

  const outputError = (step: "check" | "stage") => (cause: unknown) =>
    new DesktopSelfUpdateCommandError({ step, reason: "output", cause });

  const check = (command: UpdateCommand) =>
    run(command, "check", CHECK_TIMEOUT).pipe(
      Effect.flatMap((line) => decodeCheckOutput(line).pipe(Effect.mapError(outputError("check")))),
      Effect.map(({ update }) => update),
    );

  const stage = Effect.fn("DesktopSelfUpdate.stage")(
    function* (command: UpdateCommand) {
      const { staged } = yield* run(command, "stage", STAGE_TIMEOUT).pipe(
        Effect.flatMap((line) =>
          decodeStageOutput(line).pipe(Effect.mapError(outputError("stage"))),
        ),
      );
      yield* setState(staged ? READY : IDLE);
    },
    Effect.catchTags({ DesktopSelfUpdateCommandError: fail }),
  );

  // Runs holding the cycle; the build releases it when it ends, or this does when none starts.
  const checkAndStage = Effect.fn("DesktopSelfUpdate.checkAndStage")(function* (
    command: UpdateCommand,
    scope: Scope.Scope,
    answer: CheckAnswer,
  ) {
    const settle = (result: DesktopSelfUpdateCheckResult) =>
      Deferred.succeed(answer, result).pipe(Effect.as(result));
    const checked = yield* Effect.result(check(command));
    if (Result.isFailure(checked)) {
      yield* fail(checked.failure);
      yield* releaseCycle;
      return yield* settle({ status: "error", message: checked.failure.message });
    }
    if (!checked.success) {
      yield* setState(IDLE);
      yield* releaseCycle;
      return yield* settle({ status: "up-to-date" });
    }
    yield* setState(BUILDING);
    yield* stage(command).pipe(Effect.ensuring(releaseCycle), Effect.forkIn(scope));
    return yield* settle({ status: "started" });
  });

  const tick = Effect.fn("DesktopSelfUpdate.tick")(function* (
    command: UpdateCommand,
    scope: Scope.Scope,
  ) {
    const { claimed, answer } = yield* claimCycle;
    // A staged build waits for the user's restart; checking again would only rebuild it.
    if (!claimed || (yield* releaseIfReady(answer))) return;
    yield* checkAndStage(command, scope, answer).pipe(Effect.forkIn(scope));
  });

  const requestCheck = Effect.fn("DesktopSelfUpdate.checkNow")(function* (wait: boolean) {
    const active = yield* Ref.get(activeRef);
    if (Option.isNone(active)) return { status: "off" } as const;
    const { command, scope } = active.value;
    yield* shellEnvironment.awaitDiscovery;
    const { claimed, answer } = yield* claimCycle;
    if (!claimed) {
      const { status } = yield* Ref.get(stateRef);
      if (status === "ready" || status === "building") return { status } as const;
      return wait ? yield* Deferred.await(answer) : ({ status: "checking" } as const);
    }
    if (yield* releaseIfReady(answer)) return { status: "ready" } as const;
    const fiber = yield* checkAndStage(command, scope, answer).pipe(Effect.forkIn(scope));
    return yield* Fiber.join(fiber);
  });
  const checkNow = requestCheck(false);
  const checkAndWait = requestCheck(true);

  const restartToUpdate = Effect.gen(function* () {
    const active = yield* Ref.get(activeRef);
    if (Option.isNone(active) || (yield* Ref.get(stateRef)).status !== "ready") return false;
    if (yield* Ref.getAndSet(restarting, true)) return false;
    const [executable, ...args] = active.value.command;
    // Detached and unreferenced, so the finish step outlives this app, which it waits to quit.
    const launched = yield* spawner
      .spawn(
        ChildProcess.make(executable, [...args, "--finish"], {
          detached: true,
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
        }),
      )
      .pipe(
        Effect.flatMap((child) => child.unref),
        Effect.scoped,
        Effect.as(true),
        Effect.catch((cause) => {
          const error = new DesktopSelfUpdateCommandError({ step: "finish", reason: "run", cause });
          // The staged build is still on disk, so the state stays `ready` and a restart can retry.
          return logFailure(error).pipe(
            Effect.andThen(setState({ status: "ready", restartError: error.message })),
            Effect.andThen(Ref.set(restarting, false)),
            Effect.as(false),
          );
        }),
      );
    if (!launched) return false;
    yield* logInfo("handed the update to the update command; quitting");
    yield* electronApp.quit;
    return true;
  }).pipe(Effect.withSpan("DesktopSelfUpdate.restartToUpdate"));

  const registerIpc = Effect.gen(function* () {
    yield* ipc.handle(
      DesktopIpc.makeIpcMethod({
        channel: SelfUpdateChannels.SELF_UPDATE_GET_STATE_CHANNEL,
        payload: Schema.Void,
        result: DesktopSelfUpdateStateSchema,
        handler: () => Ref.get(stateRef),
      }),
    );
    yield* ipc.handle(
      DesktopIpc.makeIpcMethod({
        channel: SelfUpdateChannels.SELF_UPDATE_CHECK_CHANNEL,
        payload: Schema.Void,
        result: DesktopSelfUpdateCheckResultSchema,
        handler: () => checkAndWait,
      }),
    );
    yield* ipc.handle(
      DesktopIpc.makeIpcMethod({
        channel: SelfUpdateChannels.SELF_UPDATE_RESTART_CHANNEL,
        payload: Schema.Void,
        result: Schema.Boolean,
        handler: () => restartToUpdate,
      }),
    );
  }).pipe(
    Effect.catchTags({
      DesktopIpcRegistrationError: (error) => logError(error.message, { channel: error.channel }),
    }),
  );

  const start = Effect.gen(function* () {
    const scope = yield* Scope.Scope;
    yield* registerIpc;
    const raw = (yield* HostProcess.Environment).T3CODE_UPDATE_COMMAND;
    const command = decodeUpdateCommand(raw).pipe(
      Option.filter(([executable]) => path.isAbsolute(executable)),
    );
    if (Option.isNone(command)) {
      if (raw !== undefined && raw.trim() !== "") {
        yield* logWarning(
          "T3CODE_UPDATE_COMMAND is not a JSON array of strings starting with an absolute path; self update is off",
        );
      }
      return;
    }
    yield* Ref.set(activeRef, Option.some({ command: command.value, scope }));
    yield* Ref.set(stateRef, IDLE);
    yield* shellEnvironment.awaitDiscovery.pipe(
      Effect.andThen(Effect.sleep(FIRST_CHECK_DELAY)),
      Effect.andThen(
        tick(command.value, scope).pipe(
          Effect.andThen(Effect.sleep(CHECK_INTERVAL)),
          Effect.forever,
        ),
      ),
      Effect.forkIn(scope),
    );
  }).pipe(Effect.withSpan("DesktopSelfUpdate.start"));

  return DesktopSelfUpdate.of({
    getState: Ref.get(stateRef),
    start,
    enabled: Ref.get(activeRef).pipe(Effect.map(Option.isSome)),
    checkNow,
    checkAndWait,
    restartToUpdate,
  });
});

export const layer = Layer.effect(DesktopSelfUpdate, make);
