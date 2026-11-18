import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { InboxIcon } from "lucide-react";
import { memo } from "react";

import { cn } from "~/lib/utils";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { useInboxAgent } from "../../state/inboxAgent";
import { ProjectFavicon, type ProjectFaviconProject } from "../ProjectFavicon";
import { resolveSidebarRowAccessibility } from "../Sidebar.logic";
import { sidebarFolderRowId } from "../sidebar/SidebarProjectFolderHeader";
import { useSidebar } from "../ui/sidebar";
import { INBOX_STATUS_DOT, inboxFolderRowVisible } from "./inboxSidebar.logic";

/**
 * A row that opens a project's Inbox. In the Projects section it carries the project's
 * name and icon; as a folder's first row it reads "Inbox" and hides with the folder.
 */
export const InboxSidebarRow = memo(function InboxSidebarRow(props: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  /** What the row reads; screen readers hear "Inbox" and the project's name either way. */
  label: string;
  projectDisplayName: string;
  /** Shown in place of the Inbox icon, for a row named after its project. */
  favicon: ProjectFaviconProject | null;
  routeThreadKey: string | null;
  /** The folder row this row sits under; a closed folder hides it unless it is open. */
  folderRowId?: string;
  folderCollapsed?: boolean;
}) {
  const { environmentId, projectId } = props;
  const inbox = useInboxAgent({ environmentId, projectId });
  const { isMobile, setOpenMobile } = useSidebar();
  const isActive =
    inbox.threadId !== null &&
    props.routeThreadKey === scopedThreadKey(scopeThreadRef(environmentId, inbox.threadId));
  if (!inboxFolderRowVisible({ collapsed: props.folderCollapsed === true, isRoute: isActive })) {
    return null;
  }
  const dot = INBOX_STATUS_DOT[inbox.status];
  const accessibility = resolveSidebarRowAccessibility({
    title: "Inbox",
    statusLabel: dot?.label ?? null,
    projectDisplayName: props.projectDisplayName,
    isActive,
  });
  return (
    <li className="list-none py-0.5">
      <button
        type="button"
        data-sidebar-row={`inbox:${environmentId}:${projectId}`}
        data-sidebar-parent={props.folderRowId}
        data-testid="sidebar-inbox-row"
        aria-label={accessibility.label}
        aria-current={accessibility.current}
        disabled={!inbox.canOpen}
        onClick={() => {
          if (isMobile) setOpenMobile(false);
          void inbox.open();
        }}
        className={cn(
          "flex h-8 w-full cursor-pointer items-center gap-2.5 rounded-md px-(--sidebar-row-content-inset) text-left text-sm text-sidebar-foreground outline-none select-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-default disabled:opacity-60",
          isActive ? "bg-sidebar-row-active" : "hover:bg-sidebar-row-hover",
        )}
      >
        {props.favicon ? (
          <ProjectFavicon project={props.favicon} className="size-4 shrink-0" />
        ) : (
          <InboxIcon aria-hidden className="size-4 shrink-0 text-sidebar-muted-foreground" />
        )}
        <span className="min-w-0 flex-1 truncate font-medium text-sidebar-foreground/90">
          {props.label}
        </span>
        {dot ? (
          <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", dot.className)} />
        ) : null}
      </button>
    </li>
  );
});

/** A project folder's first row, above its threads. */
export function SidebarFolderInboxRow(props: {
  group: SidebarProjectSnapshot;
  collapsed: boolean;
  routeThreadKey: string | null;
}) {
  return (
    <InboxSidebarRow
      environmentId={props.group.environmentId}
      projectId={props.group.id}
      label="Inbox"
      projectDisplayName={props.group.displayName}
      favicon={null}
      routeThreadKey={props.routeThreadKey}
      folderRowId={sidebarFolderRowId(props.group.projectKey)}
      folderCollapsed={props.collapsed}
    />
  );
}
