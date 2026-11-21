import {
  type CollisionDetection,
  DndContext,
  type DragEndEvent,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { restrictToParentElement, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { Schema } from "effect";
import { memo, type MouseEvent as ReactMouseEvent, useEffect, useRef } from "react";

import { useLocalStorage } from "../../hooks/useLocalStorage";
import { useClientSettings } from "../../hooks/useSettings";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { commitProjectGroupReorder } from "../sidebar/ProjectScopeReorder";
import { CollapsibleSectionHeader } from "../ui/collapsible-section-header";
import { InboxSidebarRow, type InboxSidebarRowSortable } from "./InboxSidebarRow";
import { inboxSidebarProjects } from "./inboxSidebar.logic";

export const PROJECTS_SECTION_EXPANDED_KEY = "t3code:sidebar:projects-expanded";
const PROJECTS_SECTION_ROW_ID = "section:projects";
const POINTER_SENSOR_OPTIONS = { activationConstraint: { distance: 6 } } as const;
const DND_MODIFIERS = [restrictToVerticalAxis, restrictToParentElement];

function SortableProjectsSectionRow(props: {
  group: SidebarProjectSnapshot;
  disabled: boolean;
  routeThreadKey: string | null;
  folderCollapsed: boolean;
}) {
  const { listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: props.group.projectKey,
    disabled: props.disabled,
  });
  const sortable: InboxSidebarRowSortable = {
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  };
  return (
    <InboxSidebarRow
      environmentId={props.group.environmentId}
      projectId={props.group.id}
      label={props.group.displayName}
      projectDisplayName={props.group.displayName}
      favicon={props.group}
      routeThreadKey={props.routeThreadKey}
      folderRowId={PROJECTS_SECTION_ROW_ID}
      folderCollapsed={props.folderCollapsed}
      sortable={sortable}
    />
  );
}

/** Without project folders: one row per project in scope, each opening that project's Inbox. */
export const SidebarProjectsSection = memo(function SidebarProjectsSection(props: {
  scopedGroups: readonly SidebarProjectSnapshot[];
  pickableGroups: readonly SidebarProjectSnapshot[];
  routeThreadKey: string | null;
}) {
  const [expanded, setExpanded] = useLocalStorage(
    PROJECTS_SECTION_EXPANDED_KEY,
    true,
    Schema.Boolean,
  );
  const sortOrder = useClientSettings((settings) => settings.sidebarProjectSortOrder);
  const sensors = useSensors(useSensor(PointerSensor, POINTER_SENSOR_OPTIONS));
  const suppressClickRef = useRef(false);
  const clearSuppressTimerRef = useRef<number | null>(null);
  const clearSuppressClick = () => {
    if (clearSuppressTimerRef.current !== null) {
      window.clearTimeout(clearSuppressTimerRef.current);
      clearSuppressTimerRef.current = null;
    }
    suppressClickRef.current = false;
  };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- clears any pending post-drag click suppression timer on unmount
  useEffect(
    () => () => {
      if (clearSuppressTimerRef.current !== null) {
        window.clearTimeout(clearSuppressTimerRef.current);
        clearSuppressTimerRef.current = null;
      }
      suppressClickRef.current = false;
    },
    [],
  );

  const groups = inboxSidebarProjects(props.scopedGroups, props.pickableGroups);
  if (groups.length === 0) return null;

  const orderGroups = props.pickableGroups.length > 0 ? props.pickableGroups : groups;
  const keys = groups.map((group) => group.projectKey);
  const pinnedKeys = new Set(groups.filter((group) => group.pinned).map((g) => g.projectKey));
  const reorderDisabled = !expanded || groups.length <= 1;

  // Keep pinned and unpinned rows from shifting across the pinned boundary while dragging.
  const collisionDetection: CollisionDetection = (args) => {
    const activePinned = pinnedKeys.has(String(args.active.id));
    return closestCenter({
      ...args,
      droppableContainers: args.droppableContainers.filter(
        (container) => pinnedKeys.has(String(container.id)) === activePinned,
      ),
    });
  };

  const scheduleClearSuppressClick = () => {
    if (clearSuppressTimerRef.current !== null) {
      window.clearTimeout(clearSuppressTimerRef.current);
    }
    // Pointerup after a drag still dispatches click when the pointer stays over the row.
    clearSuppressTimerRef.current = window.setTimeout(() => {
      clearSuppressTimerRef.current = null;
      suppressClickRef.current = false;
    }, 0);
  };

  const handleDragStart = () => {
    if (clearSuppressTimerRef.current !== null) {
      window.clearTimeout(clearSuppressTimerRef.current);
      clearSuppressTimerRef.current = null;
    }
    suppressClickRef.current = true;
  };

  const handleDragEnd = (event: DragEndEvent) => {
    scheduleClearSuppressClick();
    if (event.over === null) return;
    commitProjectGroupReorder({
      groups: orderGroups,
      activeKey: String(event.active.id),
      overKey: String(event.over.id),
      sortOrder,
    });
  };

  const handleClickCapture = (event: ReactMouseEvent<HTMLUListElement>) => {
    if (!suppressClickRef.current) return;
    clearSuppressClick();
    event.preventDefault();
    event.stopPropagation();
  };

  return (
    <>
      <li className="relative mx-0.5 h-8 list-none">
        <CollapsibleSectionHeader
          data-sidebar-row={PROJECTS_SECTION_ROW_ID}
          data-testid="sidebar-projects-header"
          expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
          accessory={<span className="font-normal tabular-nums">{groups.length}</span>}
        >
          Projects
        </CollapsibleSectionHeader>
      </li>
      {/* Collapsed, the rows hide as a closed folder's Inbox does: the open Inbox stays. */}
      <li role="presentation" className="list-none has-[>ul:empty]:hidden">
        <DndContext
          sensors={sensors}
          collisionDetection={collisionDetection}
          modifiers={DND_MODIFIERS}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
          onDragCancel={scheduleClearSuppressClick}
        >
          <SortableContext items={keys} strategy={verticalListSortingStrategy}>
            <ul
              role="presentation"
              className="flex flex-col gap-px"
              onPointerDownCapture={clearSuppressClick}
              onClickCapture={handleClickCapture}
            >
              {groups.map((group) => (
                <SortableProjectsSectionRow
                  key={group.projectKey}
                  group={group}
                  disabled={reorderDisabled}
                  routeThreadKey={props.routeThreadKey}
                  folderCollapsed={!expanded}
                />
              ))}
            </ul>
          </SortableContext>
        </DndContext>
      </li>
      <li aria-hidden className="mx-2.5 my-1.5 h-px list-none bg-sidebar-border/60" />
    </>
  );
});
