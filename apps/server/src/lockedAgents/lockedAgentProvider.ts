import {
  ProviderDriverKind,
  type ServerProvider,
  defaultInstanceIdForDriver,
} from "@t3tools/contracts";

const CLAUDE_DRIVER = ProviderDriverKind.make("claudeAgent");

/**
 * The Claude provider a locked agent runs on, with the user's own sign-in. Other providers are
 * not supported: the tool lock that keeps the agent to its own tools is written for Claude's
 * options only (`lockedAgentClaudeLock.ts`), so no other adapter may run its thread.
 */
export function lockedAgentProvider(
  providers: ReadonlyArray<ServerProvider>,
): ServerProvider | undefined {
  const usable = providers.filter(
    (provider) =>
      provider.driver === CLAUDE_DRIVER &&
      provider.enabled &&
      provider.installed &&
      provider.status !== "error" &&
      provider.status !== "disabled" &&
      provider.auth.status !== "unauthenticated" &&
      provider.availability !== "unavailable",
  );
  const preferred = defaultInstanceIdForDriver(CLAUDE_DRIVER);
  return usable.find((provider) => provider.instanceId === preferred) ?? usable[0];
}
