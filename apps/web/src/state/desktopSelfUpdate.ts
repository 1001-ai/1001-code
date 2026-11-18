import { useAtomValue } from "@effect/atom-react";
import type { DesktopBridge, DesktopSelfUpdateState } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { Atom } from "effect/reactivity";

type DesktopSelfUpdateBridge = Pick<DesktopBridge, "getSelfUpdateState" | "onSelfUpdateState">;

class DesktopSelfUpdateStateReadError extends Schema.TaggedError<DesktopSelfUpdateStateReadError>()(
  "DesktopSelfUpdateStateReadError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Failed to read the desktop self-update state.";
  }
}

const updates = Stream.callback<DesktopSelfUpdateState | null>((queue) =>
  Effect.gen(function* () {
    const bridge: DesktopSelfUpdateBridge | undefined =
      typeof window === "undefined" ? undefined : window.desktopBridge;
    if (!bridge) {
      Queue.offerUnsafe(queue, null);
      return yield* Effect.never;
    }

    let receivedUpdate = false;
    yield* Effect.acquireRelease(
      Effect.sync(() =>
        bridge.onSelfUpdateState((state) => {
          receivedUpdate = true;
          Queue.offerUnsafe(queue, state);
        }),
      ),
      (unsubscribe) => Effect.sync(unsubscribe),
    );

    const initialState = yield* Effect.tryPromise({
      try: () => bridge.getSelfUpdateState(),
      catch: (cause) => new DesktopSelfUpdateStateReadError({ cause }),
    }).pipe(
      Effect.catchTags({
        DesktopSelfUpdateStateReadError: (error) =>
          Effect.logError(error.message, { error }).pipe(Effect.as(null)),
      }),
    );
    if (!receivedUpdate && initialState !== null) {
      Queue.offerUnsafe(queue, initialState);
    }

    return yield* Effect.never;
  }),
).pipe(
  // The main process repeats a state on each hourly retry; a dismissed toast stays dismissed.
  Stream.changesWith(
    (left, right) =>
      left?.status === right?.status &&
      (left?.status !== "error" || right?.status !== "error" || left.message === right.message),
  ),
);

const desktopSelfUpdateStateAtom = Atom.make(updates, { initialValue: null }).pipe(
  Atom.keepAlive,
  Atom.withLabel("desktop:self-update-state"),
);

/** Null outside the desktop app and until the main process answers. */
export function useDesktopSelfUpdateState(): DesktopSelfUpdateState | null {
  return AsyncResult.getOrElse(useAtomValue(desktopSelfUpdateStateAtom), () => null);
}
