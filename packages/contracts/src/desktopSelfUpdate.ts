import * as Schema from "effect/Schema";

/**
 * Progress of the desktop app's own update, which runs the update command a build names in
 * `T3CODE_UPDATE_COMMAND`. Without one the state stays `idle`.
 */
export const DesktopSelfUpdateStateSchema = Schema.Union([
  Schema.Struct({ status: Schema.Literal("idle") }),
  Schema.Struct({ status: Schema.Literal("building") }),
  Schema.Struct({ status: Schema.Literal("ready") }),
  Schema.Struct({ status: Schema.Literal("error"), message: Schema.String }),
]);
export type DesktopSelfUpdateState = typeof DesktopSelfUpdateStateSchema.Type;
