/**
 * What the sidebar item and palette action do. The graph and the thread's terminal share the
 * bottom area and the terminal wins while open, so showing the graph closes the terminal. Off a
 * thread it shows the graph in the last thread, closing that thread's terminal when it lands.
 */
export function teamProjectsDrawerToggle(input: {
  readonly onThread: boolean;
  readonly open: boolean;
  readonly terminalOpen: boolean;
}): { readonly open: boolean; readonly closeTerminal: boolean; readonly leaveForThread: boolean } {
  if (!input.onThread) return { open: true, closeTerminal: true, leaveForThread: true };
  const visible = input.open && !input.terminalOpen;
  return { open: !visible, closeTerminal: !visible && input.terminalOpen, leaveForThread: false };
}

/**
 * A choice the user made wins; until then the graph is on where a catalog is set. While the
 * catalog loads (`catalogSet` null), what the environment had last time decides.
 */
export function resolveTeamProjectsDrawerOpen(
  stored: boolean | null,
  catalogSet: boolean | null,
  rememberedCatalogSet: boolean | undefined,
): boolean {
  return stored ?? catalogSet ?? rememberedCatalogSet ?? false;
}
