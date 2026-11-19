import * as Schema from "effect/Schema";

/**
 * Progress of the desktop app's own update, which runs the update command a build names in
 * `T3CODE_UPDATE_COMMAND`. Without one the state stays `off`.
 */
export const DesktopSelfUpdateStateSchema = Schema.Union([
  Schema.Struct({ status: Schema.Literal("off") }),
  Schema.Struct({ status: Schema.Literal("idle") }),
  Schema.Struct({ status: Schema.Literal("building") }),
  /** `restartError` says why the last Restart to update did not start; the build stays ready. */
  Schema.Struct({ status: Schema.Literal("ready"), restartError: Schema.optional(Schema.String) }),
  Schema.Struct({ status: Schema.Literal("error"), message: Schema.String }),
]);
export type DesktopSelfUpdateState = typeof DesktopSelfUpdateStateSchema.Type;

/** What a check the user asked for found, or why none ran. */
export const DesktopSelfUpdateCheckResultSchema = Schema.Union([
  Schema.Struct({
    status: Schema.Literals(["off", "ready", "building", "checking", "up-to-date", "started"]),
  }),
  Schema.Struct({ status: Schema.Literal("error"), message: Schema.String }),
]);
export type DesktopSelfUpdateCheckResult = typeof DesktopSelfUpdateCheckResultSchema.Type;
