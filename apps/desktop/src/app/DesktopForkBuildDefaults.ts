import { forkBuildEnvDefaults } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";

import * as DesktopEnvironment from "./DesktopEnvironment.ts";

const AppPackageBuildDefaults = Schema.fromJsonString(
  Schema.Struct({
    t3codeBuildEnvDefaults: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  }),
);
const decodeAppPackageBuildDefaults = Schema.decodeEffect(AppPackageBuildDefaults);

/** Gives the backend the settings the build baked into the app's package.json, unless already set. */
export const applyBuildEnvDefaults = Effect.fn("desktop.forkBuildDefaults.apply")(
  function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    if (!environment.isPackaged) return;
    const fileSystem = yield* FileSystem.FileSystem;
    const raw = yield* fileSystem.readFileString(
      environment.path.join(environment.appRoot, "package.json"),
    );
    const { t3codeBuildEnvDefaults } = yield* decodeAppPackageBuildDefaults(raw);
    if (t3codeBuildEnvDefaults === undefined) return;
    const env = yield* HostProcess.Environment;
    Object.assign(env, forkBuildEnvDefaults(t3codeBuildEnvDefaults, env));
  },
  Effect.catchCause((cause) =>
    Effect.logWarning("Could not read the build's backend defaults", cause),
  ),
);
