import type { ModelSelection, OrchestrationV2AppThread } from "@t3tools/contracts";

import { lockedAgentKindOf } from "./lockedAgentKind.ts";

type GuardedThread = Pick<
  OrchestrationV2AppThread,
  "id" | "lineage" | "providerInstanceId" | "title"
>;

/**
 * Why a command may not run on a locked agent's thread, or null. The tool lock is written for
 * Claude's query options only, so the thread never moves to another provider instance (another
 * Claude model is fine). The Inbox also keeps its title, which is how clients find it.
 */
export function lockedAgentRefusal(
  command: {
    readonly type: string;
    readonly modelSelection?: ModelSelection | undefined;
    readonly title?: string | undefined;
    readonly regenerateTitle?: boolean | undefined;
  },
  thread: GuardedThread,
): string | null {
  const kind = lockedAgentKindOf(thread);
  if (kind === null) return null;
  if (
    command.modelSelection !== undefined &&
    command.modelSelection.instanceId !== thread.providerInstanceId
  ) {
    return "This agent runs on its own provider, which cannot change.";
  }
  if (
    kind === "inbox" &&
    command.type === "thread.metadata.update" &&
    ((command.title !== undefined && command.title !== thread.title) ||
      command.regenerateTitle === true)
  ) {
    return "The Inbox keeps its name, so every app can find it.";
  }
  return null;
}

/** A locked agent's thread keeps the title the server gave it: no message renames it. */
export function lockedAgentMessage<Command extends { readonly titleSeed?: string | undefined }>(
  command: Command,
  thread: Pick<OrchestrationV2AppThread, "id" | "lineage">,
): Command {
  if (lockedAgentKindOf(thread) === null || command.titleSeed === undefined) return command;
  const { titleSeed: _titleSeed, ...rest } = command;
  return rest as Command;
}
