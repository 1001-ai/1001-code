import * as Layer from "effect/Layer";

import * as RuntimeLayer from "../orchestration-v2/runtimeLayer.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as TeamCatalog from "../teamCatalog/TeamCatalog.ts";
import * as Memory from "./Memory.ts";

/**
 * Provided to the orchestration runtime, which builds before the server's other layers, so turns
 * can read memory. Layers memoize by reference: the catalog is the server's only one.
 */
export const layerForOrchestration = Memory.layer.pipe(
  Layer.provide(TeamCatalog.layer),
  Layer.provide(ManagedProjectFolders.layer.pipe(Layer.provide(RuntimeLayer.layerProjectService))),
);
