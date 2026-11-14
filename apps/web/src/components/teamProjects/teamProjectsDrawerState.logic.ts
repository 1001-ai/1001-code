/**
 * What the sidebar item and palette action do. The graph and the thread's terminal share the
 * bottom area and the terminal wins while open, so showing the graph closes the terminal.
 */
export function teamProjectsDrawerToggle(input: {
  readonly onThread: boolean;
  readonly open: boolean;
  readonly terminalOpen: boolean;
}): { readonly open: boolean; readonly closeTerminal: boolean; readonly leaveForThread: boolean } {
  if (!input.onThread) return { open: true, closeTerminal: false, leaveForThread: true };
  const visible = input.open && !input.terminalOpen;
  return { open: !visible, closeTerminal: !visible && input.terminalOpen, leaveForThread: false };
}

/** A choice the user made wins; until then the graph is on where a catalog is set. */
export function resolveTeamProjectsDrawerOpen(
  stored: boolean | null,
  catalogSet: boolean,
): boolean {
  return stored ?? catalogSet;
}
