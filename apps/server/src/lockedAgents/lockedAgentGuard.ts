import {
  type ModelSelection,
  type OrchestrationV2AppThread,
  type ProviderDriverKind,
  lockedAgentDriverAllowed,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { ProviderAdapterRegistryV2Shape } from "../orchestration-v2/ProviderAdapterRegistry.ts";
import { lockedAgentKindOf } from "./lockedAgentKind.ts";

type GuardedThread = Pick<
  OrchestrationV2AppThread,
  "id" | "lineage" | "providerInstanceId" | "title"
>;

export interface LockedAgentGuardedCommand {
  readonly type: string;
  readonly modelSelection?: ModelSelection | undefined;
  readonly title?: string | undefined;
  readonly regenerateTitle?: boolean | undefined;
}

/**
 * Why a command may not run on a locked agent's thread, or null. A voice agent stays on its own
 * provider instance; an Inbox may switch between providers whose adapters implement the locked
 * agent tool lock (`LOCKED_AGENT_DRIVERS.inbox`, i.e. Claude and Antigravity), and keeps its
 * title so every client can find it.
 */
export function lockedAgentRefusal(
  command: LockedAgentGuardedCommand,
  thread: GuardedThread,
  targetDriver?: ProviderDriverKind | null,
): string | null {
  const kind = lockedAgentKindOf(thread);
  if (kind === null) return null;
  if (
    command.modelSelection !== undefined &&
    command.modelSelection.instanceId !== thread.providerInstanceId
  ) {
    if (kind === "voice") {
      return "This agent runs on its own provider, which cannot change.";
    }
    if (targetDriver == null || !lockedAgentDriverAllowed(targetDriver, kind)) {
      return "The Inbox can only run on a supported provider (Claude or Antigravity).";
    }
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

/**
 * Resolves the target provider's driver when a locked thread switches provider instances, then
 * checks `lockedAgentRefusal`. Ordinary threads do no adapter lookup.
 */
export const lockedAgentCommandRefusal = (
  command: LockedAgentGuardedCommand,
  thread: GuardedThread,
  providerAdapters: Pick<ProviderAdapterRegistryV2Shape, "get">,
): Effect.Effect<string | null> => {
  if (
    lockedAgentKindOf(thread) === null ||
    command.modelSelection === undefined ||
    command.modelSelection.instanceId === thread.providerInstanceId
  ) {
    return Effect.succeed(lockedAgentRefusal(command, thread));
  }
  return providerAdapters.get(command.modelSelection.instanceId).pipe(
    Effect.map((adapter) => lockedAgentRefusal(command, thread, adapter.driver)),
    Effect.orElseSucceed(() => lockedAgentRefusal(command, thread, null)),
  );
};

/** A locked agent's thread keeps the title the server gave it: no message renames it. */
export function lockedAgentMessage<Command extends { readonly titleSeed?: string | undefined }>(
  command: Command,
  thread: Pick<OrchestrationV2AppThread, "id" | "lineage">,
): Command {
  if (lockedAgentKindOf(thread) === null || command.titleSeed === undefined) return command;
  const { titleSeed: _titleSeed, ...rest } = command;
  return rest as Command;
}
