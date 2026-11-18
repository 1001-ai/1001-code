import {
  type ModelSelection,
  type OrchestrationV2AppThread,
  lockedAgentKind,
} from "@t3tools/contracts";

type GuardedThread = Pick<OrchestrationV2AppThread, "lineage" | "providerInstanceId">;

/**
 * A locked agent's tool lock is written for Claude's query options only, so its thread never
 * moves to another provider instance: a command that would move it is refused. Its model may
 * change like any thread's.
 */
export function lockedAgentRefusesProvider(
  command: { readonly modelSelection?: ModelSelection | undefined },
  thread: GuardedThread,
): boolean {
  return (
    lockedAgentKind(thread.lineage) !== null &&
    command.modelSelection !== undefined &&
    command.modelSelection.instanceId !== thread.providerInstanceId
  );
}

/** A locked agent's thread keeps the title the server gave it: no message renames it. */
export function lockedAgentMessage<Command extends { readonly titleSeed?: string | undefined }>(
  command: Command,
  thread: GuardedThread,
): Command {
  if (lockedAgentKind(thread.lineage) === null || command.titleSeed === undefined) return command;
  const { titleSeed: _titleSeed, ...rest } = command;
  return rest as Command;
}
