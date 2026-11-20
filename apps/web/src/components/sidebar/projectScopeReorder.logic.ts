import { arrayMove } from "@dnd-kit/sortable";

/**
 * The menu's project keys after dragging `activeKey` onto `overKey`, or null when nothing moves.
 * Pinned projects always list first, so a drop across the pinned line is refused.
 */
export function moveProjectScopeKey(input: {
  readonly keys: readonly string[];
  readonly pinnedKeys: ReadonlySet<string>;
  readonly activeKey: string;
  readonly overKey: string;
}): string[] | null {
  const { keys, pinnedKeys, activeKey, overKey } = input;
  const from = keys.indexOf(activeKey);
  const to = keys.indexOf(overKey);
  if (from === -1 || to === -1 || from === to) return null;
  if (pinnedKeys.has(activeKey) !== pinnedKeys.has(overKey)) return null;
  return arrayMove([...keys], from, to);
}

/**
 * The saved project order for groups listed in `groups` order: every checkout of a group stays
 * together, and saved keys of projects the menu does not list (archived, offline) follow.
 */
export function projectOrderForGroups(input: {
  readonly groups: ReadonlyArray<{
    readonly memberProjects: ReadonlyArray<{ readonly physicalProjectKey: string }>;
  }>;
  readonly previousOrder: readonly string[];
}): string[] {
  const order = input.groups.flatMap((group) =>
    group.memberProjects.map((member) => member.physicalProjectKey),
  );
  const listed = new Set(order);
  return [...order, ...input.previousOrder.filter((key) => !listed.has(key))];
}
