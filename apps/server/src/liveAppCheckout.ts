import { setLiveAppCheckout } from "@t3tools/provider-core/server/runtimeInstructions";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "./config.ts";

/** The git work tree the server's own code runs from, only in dev mode. */
export const resolveLiveAppCheckout = Effect.fn("LiveAppCheckout.resolve")(function* (input: {
  readonly devUrl: URL | undefined;
  readonly sourceDir: string;
}) {
  if (input.devUrl === undefined) return undefined;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  let dir = path.resolve(input.sourceDir);
  while (true) {
    // A linked worktree has a `.git` file, a main checkout a `.git` directory.
    const found = yield* fs.exists(path.join(dir, ".git")).pipe(Effect.orElseSucceed(() => false));
    // Only this repository counts, not some unrelated checkout above an installed copy.
    if (found) {
      const isApp = yield* fs
        .exists(path.join(dir, "apps", "server", "package.json"))
        .pipe(Effect.orElseSucceed(() => false));
      return isApp ? dir : undefined;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
});

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const checkout = yield* resolveLiveAppCheckout({
      devUrl: config.devUrl,
      sourceDir: import.meta.dirname,
    });
    setLiveAppCheckout(checkout);
  }),
);
