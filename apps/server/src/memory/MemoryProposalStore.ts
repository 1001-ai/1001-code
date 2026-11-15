import { MemoryProposal, ProjectId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";

export const StoredMemoryProposal = Schema.Struct({
  ...MemoryProposal.fields,
  projectId: ProjectId,
  /** The client session whose click decided it; agents hold no client session. */
  decidedBySession: Schema.NullOr(Schema.String),
});
export type StoredMemoryProposal = typeof StoredMemoryProposal.Type;

/**
 * Memory proposals, kept in a file in the state directory beside the team catalog checkout. Upstream
 * owns the numbered database migrations, so the fork stores this outside the database.
 */
export class MemoryProposalStore extends Context.Service<
  MemoryProposalStore,
  {
    /** Every stored proposal; none when the file is missing or unreadable. */
    readonly load: Effect.Effect<ReadonlyArray<StoredMemoryProposal>>;
    readonly save: (proposals: ReadonlyArray<StoredMemoryProposal>) => Effect.Effect<void>;
  }
>()("t3/memory/MemoryProposalStore") {}

const ProposalsFile = Schema.fromJsonString(
  Schema.Struct({ proposals: Schema.Array(StoredMemoryProposal) }),
);
const decodeProposalsFile = Schema.decodeUnknownOption(ProposalsFile);
const encodeProposalsFile = Schema.encodeSync(ProposalsFile);

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.join(config.stateDir, "memory");
  const file = path.join(directory, "proposals.json");

  const load: MemoryProposalStore["Service"]["load"] = fileSystem.readFileString(file).pipe(
    Effect.map((text) =>
      Option.match(decodeProposalsFile(text), {
        onNone: () => [],
        onSome: (decoded) => decoded.proposals,
      }),
    ),
    Effect.orElseSucceed(() => []),
  );

  const save = Effect.fn("MemoryProposalStore.save")(
    function* (proposals: ReadonlyArray<StoredMemoryProposal>) {
      const temporary = `${file}.tmp`;
      yield* fileSystem.makeDirectory(directory, { recursive: true });
      yield* fileSystem.writeFileString(temporary, encodeProposalsFile({ proposals }));
      // A rename replaces the file whole, so a crash never leaves half a file behind.
      yield* fileSystem.rename(temporary, file);
    },
    Effect.catchCause((cause) =>
      Effect.logWarning("Memory proposals could not be saved.", { cause }),
    ),
  );

  return MemoryProposalStore.of({ load, save });
});

export const layer = Layer.effect(MemoryProposalStore, make);
