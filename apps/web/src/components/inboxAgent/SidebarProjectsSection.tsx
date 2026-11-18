import { memo } from "react";

import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { InboxSidebarRow } from "./InboxSidebarRow";
import { inboxSidebarProjects } from "./inboxSidebar.logic";

/** Without project folders: one row per project in scope, each opening that project's Inbox. */
export const SidebarProjectsSection = memo(function SidebarProjectsSection(props: {
  scopedGroups: readonly SidebarProjectSnapshot[];
  pickableGroups: readonly SidebarProjectSnapshot[];
  routeThreadKey: string | null;
}) {
  const groups = inboxSidebarProjects(props.scopedGroups, props.pickableGroups);
  if (groups.length === 0) return null;
  return (
    <>
      <li
        aria-hidden
        data-testid="sidebar-projects-header"
        className="flex h-8 list-none items-center px-2 text-xs font-medium text-sidebar-muted-foreground"
      >
        Projects
      </li>
      {groups.map((group) => (
        <InboxSidebarRow
          key={group.projectKey}
          environmentId={group.environmentId}
          projectId={group.id}
          label={group.displayName}
          projectDisplayName={group.displayName}
          favicon={group}
          routeThreadKey={props.routeThreadKey}
        />
      ))}
      <li aria-hidden className="mx-2.5 my-1.5 h-px list-none bg-sidebar-border/60" />
    </>
  );
});
