import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { resolveLiveAppCheckout } from "./liveAppCheckout.ts";

const DEV_URL = new URL("http://127.0.0.1:5733");

it.layer(NodeServices.layer)("resolveLiveAppCheckout", (it) => {
  it.effect("finds the work tree above the source only in dev mode", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-live-checkout-" });
      const sourceDir = path.join(root, "apps", "server", "src");
      yield* fs.makeDirectory(sourceDir, { recursive: true });
      // A linked worktree's `.git` is a file.
      yield* fs.writeFileString(path.join(root, ".git"), "gitdir: /elsewhere\n");

      assert.strictEqual(yield* resolveLiveAppCheckout({ devUrl: DEV_URL, sourceDir }), root);
      assert.strictEqual(
        yield* resolveLiveAppCheckout({ devUrl: undefined, sourceDir }),
        undefined,
      );
    }),
  );

  it.effect("finds nothing in dev mode outside a git work tree", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-live-checkout-" });
      const sourceDir = path.join(root, "server");
      yield* fs.makeDirectory(sourceDir, { recursive: true });

      const checkout = yield* resolveLiveAppCheckout({ devUrl: DEV_URL, sourceDir });
      // The temp dir may itself sit inside some repository; it must not be this one.
      assert.isTrue(checkout === undefined || !checkout.startsWith(root));
    }),
  );
});
