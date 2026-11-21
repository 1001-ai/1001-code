import { CSS } from "@dnd-kit/utilities";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import type { InboxSidebarRowSortable } from "./InboxSidebarRow";

const rowClickSpy = vi.fn<(label: string) => void>();

vi.mock(import("./InboxSidebarRow"), () => ({
  InboxSidebarRow: ((props: {
    label: string;
    folderCollapsed?: boolean;
    sortable?: InboxSidebarRowSortable;
  }) => (
    <li
      ref={props.sortable?.setNodeRef}
      {...(props.sortable?.listeners ?? {})}
      data-testid="projects-section-row"
      data-collapsed={String(props.folderCollapsed)}
      data-dragging={props.sortable?.isDragging ? "true" : undefined}
      style={{
        height: "32px",
        transform: props.sortable?.transform
          ? CSS.Translate.toString(props.sortable.transform)
          : undefined,
      }}
    >
      <button type="button" onClick={() => rowClickSpy(props.label)}>
        {props.label}
      </button>
    </li>
  )) as never,
}));

import { render } from "../../../test/render";
import { getClientSettings, updateClientSettings } from "../../hooks/useSettings";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { useUiStateStore } from "../../uiStateStore";
import { PROJECTS_SECTION_EXPANDED_KEY, SidebarProjectsSection } from "./SidebarProjectsSection";

function makeGroup(
  name: string,
  options: { pinned?: boolean; memberKeys?: readonly string[] } = {},
): SidebarProjectSnapshot {
  const memberKeys = options.memberKeys ?? [`env:${name}`];
  return {
    projectKey: name,
    displayName: name,
    id: ProjectId.make(name),
    environmentId: EnvironmentId.make("env"),
    pinned: options.pinned ?? false,
    memberProjects: memberKeys.map((physicalProjectKey) => ({ physicalProjectKey })),
  } as unknown as SidebarProjectSnapshot;
}

const groups = [makeGroup("Acme"), makeGroup("No project")];

function section(
  pickableGroups: readonly SidebarProjectSnapshot[] = groups,
  scopedGroups: readonly SidebarProjectSnapshot[] = [],
) {
  return (
    <ul>
      <SidebarProjectsSection
        scopedGroups={scopedGroups}
        pickableGroups={pickableGroups}
        routeThreadKey={null}
      />
    </ul>
  );
}

async function dragRow(fromEl: Element, toEl: Element) {
  const fromRect = fromEl.getBoundingClientRect();
  const toRect = toEl.getBoundingClientRect();
  const startX = fromRect.left + fromRect.width / 2;
  const startY = fromRect.top + fromRect.height / 2;
  const endY = toRect.top + toRect.height / 2;
  const pointer = (type: string, x: number, y: number) =>
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      isPrimary: true,
      button: 0,
      buttons: type === "pointerup" ? 0 : 1,
      pointerId: 1,
      clientX: x,
      clientY: y,
    });

  fromEl.dispatchEvent(pointer("pointerdown", startX, startY));
  document.dispatchEvent(pointer("pointermove", startX, startY + (endY > startY ? 10 : -10)));
  await vi.waitFor(() => {
    expect(fromEl).toHaveAttribute("data-dragging", "true");
  });
  document.dispatchEvent(pointer("pointermove", startX, endY));
  await vi.waitFor(() => {
    expect((fromEl as HTMLElement).style.transform).toContain(`${Math.round(endY - startY)}px`);
  });
  document.dispatchEvent(pointer("pointerup", startX, endY));
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
    await expect
      .element(screen.getByText("No project").element().closest("li")!)
      .toHaveAttribute("data-collapsed", "true");
  }
  await using screen = await render(section());
  const header = screen.getByTestId("sidebar-projects-header");
  await expect.element(header).toHaveAttribute("aria-expanded", "false");
  await expect
    .element(screen.getByText("Acme").element().closest("li")!)
    .toHaveAttribute("data-collapsed", "true");
  await userEvent.click(header);
  await expect
    .element(screen.getByText("Acme").element().closest("li")!)
    .toHaveAttribute("data-collapsed", "false");
});

it("drags project rows directly to save manual order without grip icons and preserves clicks", async () => {
  rowClickSpy.mockReset();
  localStorage.removeItem(PROJECTS_SECTION_EXPANDED_KEY);
  const previousOrder = useUiStateStore.getState().projectOrder;
  const previousSortOrder = getClientSettings().sidebarProjectSortOrder;
  useUiStateStore.setState({ projectOrder: ["env:archived"] });
  await updateClientSettings({ sidebarProjectSortOrder: "updated_at" });
  using _cleanup = {
    [Symbol.dispose]: () => {
      localStorage.removeItem(PROJECTS_SECTION_EXPANDED_KEY);
      useUiStateStore.setState({ projectOrder: previousOrder });
      void updateClientSettings({ sidebarProjectSortOrder: previousSortOrder });
    },
  };

  const projectGroups = [
    makeGroup("Pinned", { pinned: true }),
    makeGroup("Alpha", { memberKeys: ["local:alpha", "remote:alpha"] }),
    makeGroup("Beta"),
  ];
  await using screen = await render(section(projectGroups));

  // No always-visible drag grip icons on rows.
  expect(screen.container.querySelector("[data-project-scope-grip]")).toBeNull();

  // Normal clicks work.
  await userEvent.click(screen.getByText("Alpha"));
  expect(rowClickSpy).toHaveBeenCalledWith("Alpha");
  rowClickSpy.mockReset();

  // Dragging Beta onto Alpha reorders unpinned projects, keeps multi-checkout keys together,
  // switches Project order to Manual, and suppresses a trailing click on the dragged row.
  const betaRow = screen.getByText("Beta").element().closest("li")!;
  const alphaRow = screen.getByText("Alpha").element().closest("li")!;
  await dragRow(betaRow, alphaRow);
  betaRow.querySelector("button")!.click();
  expect(rowClickSpy).not.toHaveBeenCalled();

  await vi.waitFor(() => {
    expect(useUiStateStore.getState().projectOrder).toEqual([
      "env:Pinned",
      "env:Beta",
      "local:alpha",
      "remote:alpha",
      "env:archived",
    ]);
  });
  expect(getClientSettings().sidebarProjectSortOrder).toBe("manual");

  // Dragging an unpinned project onto a pinned one is refused.
  const pinnedRow = screen.getByText("Pinned").element().closest("li")!;
  await dragRow(betaRow, pinnedRow);
  expect(useUiStateStore.getState().projectOrder).toEqual([
    "env:Pinned",
    "env:Beta",
    "local:alpha",
    "remote:alpha",
    "env:archived",
  ]);
});

it("keeps unselected projects in place when dragging inside a filtered Projects section", async () => {
  localStorage.removeItem(PROJECTS_SECTION_EXPANDED_KEY);
  const previousOrder = useUiStateStore.getState().projectOrder;
  const previousSortOrder = getClientSettings().sidebarProjectSortOrder;
  useUiStateStore.setState({ projectOrder: [] });
  await updateClientSettings({ sidebarProjectSortOrder: "updated_at" });
  using _cleanup = {
    [Symbol.dispose]: () => {
      localStorage.removeItem(PROJECTS_SECTION_EXPANDED_KEY);
      useUiStateStore.setState({ projectOrder: previousOrder });
      void updateClientSettings({ sidebarProjectSortOrder: previousSortOrder });
    },
  };

  const alpha = makeGroup("Alpha");
  const beta = makeGroup("Beta");
  const gamma = makeGroup("Gamma");
  const delta = makeGroup("Delta");
  await using screen = await render(section([alpha, beta, gamma, delta], [beta, delta]));

  const deltaRow = screen.getByText("Delta").element().closest("li")!;
  const betaRow = screen.getByText("Beta").element().closest("li")!;
  await dragRow(deltaRow, betaRow);

  await vi.waitFor(() => {
    expect(useUiStateStore.getState().projectOrder).toEqual([
      "env:Alpha",
      "env:Delta",
      "env:Beta",
      "env:Gamma",
    ]);
  });
});
