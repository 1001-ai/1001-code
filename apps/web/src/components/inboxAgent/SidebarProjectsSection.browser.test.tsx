import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

vi.mock(import("./InboxSidebarRow"), () => ({
  InboxSidebarRow: ((props: { label: string; folderCollapsed?: boolean }) => (
    <li data-testid="projects-section-row" data-collapsed={String(props.folderCollapsed)}>
      {props.label}
    </li>
  )) as never,
}));

import { render } from "../../../test/render";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { PROJECTS_SECTION_EXPANDED_KEY, SidebarProjectsSection } from "./SidebarProjectsSection";

const groups = ["Acme", "No project"].map(
  (name) =>
    ({
      projectKey: name,
      displayName: name,
      id: ProjectId.make(name),
      environmentId: EnvironmentId.make("env"),
    }) as SidebarProjectSnapshot,
);

function section() {
  return (
    <ul>
      <SidebarProjectsSection scopedGroups={[]} pickableGroups={groups} routeThreadKey={null} />
    </ul>
  );
}

it("collapses its rows and remembers it across reloads", async () => {
  localStorage.removeItem(PROJECTS_SECTION_EXPANDED_KEY);
  using _storage = {
    [Symbol.dispose]: () => localStorage.removeItem(PROJECTS_SECTION_EXPANDED_KEY),
  };
  {
    await using screen = await render(section());
    const header = screen.getByTestId("sidebar-projects-header");
    await expect.element(header).toHaveAttribute("aria-expanded", "true");
    await expect.element(screen.getByText("No project")).toBeInTheDocument();
    await userEvent.click(header);
    await expect.element(header).toHaveAttribute("aria-expanded", "false");
    await expect.element(screen.getByText("No project")).toHaveAttribute("data-collapsed", "true");
  }
  await using screen = await render(section());
  const header = screen.getByTestId("sidebar-projects-header");
  await expect.element(header).toHaveAttribute("aria-expanded", "false");
  await expect.element(screen.getByText("Acme")).toHaveAttribute("data-collapsed", "true");
  await userEvent.click(header);
  await expect.element(screen.getByText("Acme")).toHaveAttribute("data-collapsed", "false");
});
