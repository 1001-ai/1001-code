import { DesktopSelfUpdateStateSchema, type DesktopSelfUpdateState } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
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
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    const detail =
      this.reason === "run"
        ? "the update command did not run"
        : this.reason === "exit"
          ? `the update command exited with code ${this.exitCode}`
          : this.reason === "output"
            ? "the update command's answer was not understood"
            : "the update command took too long";
    return `${STEP_MESSAGES[this.step]}: ${detail}.`;
  }
}

export class DesktopSelfUpdate extends Context.Service<
  DesktopSelfUpdate,
  {
    readonly getState: Effect.Effect<DesktopSelfUpdateState>;
    /** Serves the renderer and, when the build names an update command, checks soon and hourly. */
    readonly start: Effect.Effect<void, never, Scope.Scope>;
    /** Only when `ready`: launches the command's finish step, then quits. False when it did not. */
    readonly restartToUpdate: Effect.Effect<boolean>;
  }
>()("@t3tools/desktop/updates/DesktopSelfUpdate") {}

const { logInfo, logWarning, logError } =
  DesktopObservability.makeComponentLogger("desktop-self-update");

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

  const stateRef = yield* Ref.make<DesktopSelfUpdateState>(IDLE);
  const commandRef = yield* Ref.make(Option.none<UpdateCommand>());
  const cycleRunning = yield* Ref.make(false);
  const restarting = yield* Ref.make(false);

  const setState = Effect.fn("DesktopSelfUpdate.setState")(function* (
    state: DesktopSelfUpdateState,
  ) {
    yield* Ref.set(stateRef, state);
    yield* logInfo("self update state changed", { status: state.status });
    yield* electronWindow.sendAll(SelfUpdateChannels.SELF_UPDATE_STATE_CHANNEL, state);
  });

  const fail = Effect.fn("DesktopSelfUpdate.fail")(function* (
    error: DesktopSelfUpdateCommandError,
  ) {
    yield* logError(error.message, {
      step: error.step,
      reason: error.reason,
      ...(error.cause === undefined ? {} : { cause: error.cause }),
    });
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
        cause: lastLine(stderr),
      });
    }
    return lastLine(stdout);
  });

  const outputError = (step: "check" | "stage") => (cause: unknown) =>
    new DesktopSelfUpdateCommandError({ step, reason: "output", cause });

  const cycle = Effect.fn("DesktopSelfUpdate.cycle")(
    function* (command: UpdateCommand) {
      const { update } = yield* run(command, "check", CHECK_TIMEOUT).pipe(
        Effect.flatMap((line) =>
          decodeCheckOutput(line).pipe(Effect.mapError(outputError("check"))),
        ),
      );
      if (!update) return yield* setState(IDLE);
      yield* setState(BUILDING);
      const { staged } = yield* run(command, "stage", STAGE_TIMEOUT).pipe(
        Effect.flatMap((line) =>
          decodeStageOutput(line).pipe(Effect.mapError(outputError("stage"))),
        ),
      );
      yield* setState(staged ? READY : IDLE);
    },
    Effect.catchTags({ DesktopSelfUpdateCommandError: fail }),
  );

  const tick = Effect.fn("DesktopSelfUpdate.tick")(function* (
    command: UpdateCommand,
    scope: Scope.Scope,
  ) {
    // A staged build waits for the user's restart; checking again would only rebuild it.
    if ((yield* Ref.get(stateRef)).status === "ready") return;
    if (yield* Ref.getAndSet(cycleRunning, true)) return;
    yield* cycle(command).pipe(Effect.ensuring(Ref.set(cycleRunning, false)), Effect.forkIn(scope));
  });

  const restartToUpdate = Effect.gen(function* () {
    const command = yield* Ref.get(commandRef);
    if (Option.isNone(command) || (yield* Ref.get(stateRef)).status !== "ready") return false;
    if (yield* Ref.getAndSet(restarting, true)) return false;
    const [executable, ...args] = command.value;
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
        Effect.catch((cause) =>
          fail(new DesktopSelfUpdateCommandError({ step: "finish", reason: "run", cause })).pipe(
            Effect.andThen(Ref.set(restarting, false)),
            Effect.as(false),
          ),
        ),
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
    yield* Ref.set(commandRef, command);
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

  return DesktopSelfUpdate.of({ getState: Ref.get(stateRef), start, restartToUpdate });
});

export const layer = Layer.effect(DesktopSelfUpdate, make);
