import { assert, it } from "@effect/vitest";
import { FORK_UPDATES_MESSAGE, type ManagedUpdatesPolicy } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as DesktopManagedPolicy from "../app/DesktopManagedPolicy.ts";
import * as DesktopUpdatePolicy from "./DesktopUpdatePolicy.ts";

const resolve = (updates?: ManagedUpdatesPolicy) =>
  Effect.service(DesktopUpdatePolicy.DesktopUpdatePolicy).pipe(
    Effect.provide(
      DesktopUpdatePolicy.layer.pipe(
        Layer.provide(
          DesktopManagedPolicy.layerTest(
            updates === undefined
              ? undefined
              : { schemaVersion: 1, organization: "Example Corp", limits: { updates } },
          ),
        ),
      ),
    ),
  );

it.effect.each([
  { name: "no policy", updates: undefined, mode: "off", message: FORK_UPDATES_MESSAGE },
  {
    name: "a policy without a mirror",
    updates: { mode: "auto" },
    mode: "off",
    message: FORK_UPDATES_MESSAGE,
  },
  {
    name: "a policy that turns updates off",
    updates: { mode: "off" },
    mode: "off",
    message: "Example Corp manages T3 Code updates.",
  },
  {
    name: "a policy that names a mirror",
    updates: { mode: "auto", feedUrl: "https://updates.example.com/t3code/" },
    mode: "auto",
    message: "Example Corp manages T3 Code updates.",
  },
] as const)("desktop updates under $name", ({ updates, mode, message }) =>
  Effect.gen(function* () {
    const policy = yield* resolve(updates);
    assert.equal(policy.mode, mode);
    assert.equal(policy.message, message);
  }),
);
