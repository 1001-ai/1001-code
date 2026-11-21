import { Schema } from "effect";
import { memo } from "react";

import { useLocalStorage } from "../../hooks/useLocalStorage";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { CollapsibleSectionHeader } from "../ui/collapsible-section-header";
import { InboxSidebarRow } from "./InboxSidebarRow";
import { inboxSidebarProjects } from "./inboxSidebar.logic";

export const PROJECTS_SECTION_EXPANDED_KEY = "t3code:sidebar:projects-expanded";

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
  const groups = inboxSidebarProjects(props.scopedGroups, props.pickableGroups);
  if (groups.length === 0) return null;
  return (
    <>
      <li className="relative mx-0.5 h-8 list-none">
        <CollapsibleSectionHeader
          data-sidebar-row="section:projects"
          data-testid="sidebar-projects-header"
          expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
          accessory={<span className="font-normal tabular-nums">{groups.length}</span>}
        >
          Projects
        </CollapsibleSectionHeader>
      </li>
      {expanded
        ? groups.map((group) => (
            <InboxSidebarRow
              key={group.projectKey}
              environmentId={group.environmentId}
              projectId={group.id}
              label={group.displayName}
              projectDisplayName={group.displayName}
              favicon={group}
              routeThreadKey={props.routeThreadKey}
            />
          ))
        : null}
      <li aria-hidden className="mx-2.5 my-1.5 h-px list-none bg-sidebar-border/60" />
    </>
  );
});
