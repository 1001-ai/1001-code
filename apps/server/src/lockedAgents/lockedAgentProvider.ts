import {
  LOCKED_AGENT_DRIVERS,
  type LockedAgentKind,
  type ServerProvider,
  defaultInstanceIdForDriver,
} from "@t3tools/contracts";

function isUsableProvider(provider: ServerProvider): boolean {
  return (
    provider.enabled &&
    provider.installed &&
    provider.status !== "error" &&
    provider.status !== "disabled" &&
    provider.auth.status !== "unauthenticated" &&
    provider.availability !== "unavailable"
  );
}

/**
 * Every usable provider that can run a locked agent of `kind`, ordered by `LOCKED_AGENT_DRIVERS`
 * preference and, within each driver, its default instance first. Only adapters with an equivalent
 * tool lock (`lockedAgentClaudeLock.ts`, `lockedAgentAntigravityLock.ts`) belong in that list.
 */
export function lockedAgentProviders(
  providers: ReadonlyArray<ServerProvider>,
  kind: LockedAgentKind = "voice",
): ReadonlyArray<ServerProvider> {
  const result: Array<ServerProvider> = [];
  for (const driver of LOCKED_AGENT_DRIVERS[kind]) {
    const usable = providers.filter(
      (provider) => provider.driver === driver && isUsableProvider(provider),
    );
    const preferredId = defaultInstanceIdForDriver(driver);
    const preferred = usable.find((provider) => provider.instanceId === preferredId);
    if (preferred !== undefined) result.push(preferred);
    for (const provider of usable) {
      if (provider.instanceId !== preferredId) result.push(provider);
    }
  }
  return result;
}

/** The preferred usable provider for a locked agent of `kind`, with the user's own sign-in. */
export function lockedAgentProvider(
  providers: ReadonlyArray<ServerProvider>,
  kind: LockedAgentKind = "voice",
): ServerProvider | undefined {
  return lockedAgentProviders(providers, kind)[0];
}
