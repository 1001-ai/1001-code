import {
  DndContext,
  type DragEndEvent,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { restrictToParentElement, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVerticalIcon } from "lucide-react";
import { type ComponentProps, createContext, use, useState } from "react";

import type { SidebarProjectSortOrder } from "@t3tools/contracts/settings";

import { updateClientSettings, useClientSettings } from "../../hooks/useSettings";
import { keepOrder } from "../../hooks/useOrderWhileOpen";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { useUiStateStore } from "../../uiStateStore";
import { ComboboxItem, ComboboxList } from "../ui/combobox";
import { moveProjectScopeKey, projectOrderForGroups } from "./projectScopeReorder.logic";

const ReorderDisabledContext = createContext(true);
const GRIP_SELECTOR = "[data-project-scope-grip]";

/**
 * Moves `activeKey` onto `overKey` within `groups`, saves the resulting manual order on this
 * device, and switches Project order to Manual. Returns the new key order, or null when nothing
 * moves (including drops across the pinned line).
 */
export function commitProjectGroupReorder(input: {
  readonly groups: readonly SidebarProjectSnapshot[];
  readonly activeKey: string;
  readonly overKey: string;
  readonly sortOrder: SidebarProjectSortOrder;
}): string[] | null {
  const keys = input.groups.map((group) => group.projectKey);
  const groupByKey = new Map(input.groups.map((group) => [group.projectKey, group] as const));
  const moved = moveProjectScopeKey({
    keys,
    pinnedKeys: new Set(keys.filter((key) => groupByKey.get(key)?.pinned)),
    activeKey: input.activeKey,
    overKey: input.overKey,
  });
  if (moved === null) return null;
  const movedGroups = moved.flatMap((key) => groupByKey.get(key) ?? []);
  useUiStateStore.setState((state) => ({
    projectOrder: projectOrderForGroups({ groups: movedGroups, previousOrder: state.projectOrder }),
  }));
  if (input.sortOrder !== "manual") {
    void updateClientSettings({ sidebarProjectSortOrder: "manual" });
  }
  return moved;
}

/** Shows a drop in the open menu at once; the menu otherwise keeps its opening order. */
export function useProjectScopeDropOrder<TItem extends { readonly value: string }>(
  items: ReadonlyArray<TItem>,
  open: boolean,
): { readonly items: TItem[]; readonly showOrder: (keys: readonly string[]) => void } {
  const [order, setOrder] = useState<readonly string[] | null>(null);
  if (!open && order !== null) setOrder(null);
  return {
    items: keepOrder(items, open ? order : null, (item) => item.value),
    showOrder: setOrder,
  };
}

/**
 * Lets the project filter's rows be dragged into a saved order. A drop saves the order on this
 * device and turns Project order to Manual, which is what makes the sidebar use it.
 */
export function ProjectScopeReorderList({
  items,
  groupByKey,
  disabled,
  onReordered,
  ...listProps
}: ComponentProps<typeof ComboboxList> & {
  readonly items: ReadonlyArray<{ readonly value: string }>;
  readonly groupByKey: ReadonlyMap<string, SidebarProjectSnapshot>;
  readonly disabled: boolean;
  readonly onReordered: (keys: readonly string[]) => void;
}) {
  const projectGroups = items.flatMap((item) => groupByKey.get(item.value) ?? []);
  const keys = projectGroups.map((group) => group.projectKey);
  const sortOrder = useClientSettings((settings) => settings.sidebarProjectSortOrder);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const handleDragEnd = (event: DragEndEvent) => {
    if (event.over === null) return;
    const moved = commitProjectGroupReorder({
      groups: projectGroups,
      activeKey: String(event.active.id),
      overKey: String(event.over.id),
      sortOrder,
    });
    if (moved === null) return;
    // Rows the menu shows that are not projects ("All projects") keep their places in front.
    onReordered([
      ...items.map((item) => item.value).filter((key) => !groupByKey.has(key)),
      ...moved,
    ]);
  };
  return (
    <ReorderDisabledContext value={disabled}>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        modifiers={[restrictToVerticalAxis, restrictToParentElement]}
        onDragEnd={handleDragEnd}
      >
        <SortableContext items={keys} strategy={verticalListSortingStrategy}>
          <ComboboxList {...listProps} />
        </SortableContext>
      </DndContext>
    </ReorderDisabledContext>
  );
}

/** A project filter row with a drag grip; `sortKey` null is a row that stays put. */
export function ProjectScopeSortableItem({
  sortKey,
  children,
  style,
  ...props
}: ComponentProps<typeof ComboboxItem> & { readonly sortKey: string | null }) {
  const listDisabled = use(ReorderDisabledContext);
  const disabled = sortKey === null || listDisabled;
  const { listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } =
    useSortable({ id: sortKey ?? "", disabled });
  return (
    <ComboboxItem
      ref={setNodeRef}
      style={{
        ...style,
        transform: CSS.Translate.toString(transform),
        transition,
        ...(isDragging
          ? {
              position: "relative",
              zIndex: 10,
              background: "var(--popover)",
              boxShadow: "0 4px 12px rgb(0 0 0 / 0.2)",
            }
          : null),
      }}
      {...props}
      onPointerDownCapture={(event) => {
        // Base UI prevents every press on a row to keep focus in the search box, and dnd-kit
        // ignores a prevented press. The grip's mousedown is still prevented, so focus stays.
        if (!disabled && event.target instanceof Element && event.target.closest(GRIP_SELECTOR)) {
          event.preventBaseUIHandler();
        }
        props.onPointerDownCapture?.(event);
      }}
    >
      {disabled ? (
        // Keeps names aligned with the rows that show a grip.
        <span className="w-3 shrink-0" />
      ) : (
        <span
          ref={setActivatorNodeRef}
          aria-hidden="true"
          data-project-scope-grip=""
          className="flex w-3 shrink-0 cursor-grab touch-none justify-center text-muted-foreground opacity-0 in-data-highlighted:opacity-100 active:cursor-grabbing"
          onPointerDown={(event) => {
            listeners?.onPointerDown?.(event);
            event.stopPropagation();
          }}
          // A press or drop on the grip must not toggle the row's project in the filter.
          onMouseUp={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
        >
          <GripVerticalIcon className="size-3" />
        </span>
      )}
      {children}
    </ComboboxItem>
  );
}
