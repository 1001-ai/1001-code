import {
  EnvironmentId,
  MessageId,
  ProjectId,
  ThreadId,
  type ProjectMoment,
} from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

vi.mock(import("~/state/agentsBoard"), async (original) => ({
  ...(await original()),
  useAgentsBoard: (() => null) as never,
}));
vi.mock(import("~/state/teamCatalog"), async (original) => ({
  ...(await original()),
  useTeamCatalog: (() => null) as never,
}));
vi.mock(import("~/state/entities"), async (original) => ({
  ...(await original()),
  useThreadShellsForProjectRefs: (() => []) as never,
}));
vi.mock(import("~/state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => () => Promise.resolve()) as never,
}));

import { render } from "../../../test/render";
import { ACTIVITY_LIST_SHOWN_KEY } from "./ActivityListToggle";
import { TimelineMomentCards } from "./TimelineMomentCards";

const NOW = Date.parse("2026-11-20T12:00:00Z");
const threadId = ThreadId.make("thread-1");
const moment: ProjectMoment = {
  id: "moment-1",
  kind: "thread-started",
  threadId,
  threadTitle: "Exports",
  at: new Date(NOW).toISOString(),
  messageId: MessageId.make("message-1"),
  snippet: "Add the export button",
  sender: { kind: "user", title: null },
};

function cards() {
  return (
    <div className="relative h-96 w-96">
      <TimelineMomentCards
        threadRef={{ environmentId: EnvironmentId.make("env"), threadId }}
        projectId={ProjectId.make("project")}
        moments={[moment]}
        gutterWidth={384}
        rows={[]}
        stripMap={new Map()}
        onWheel={() => {}}
        onJump={() => {}}
      />
    </div>
  );
}

it("hides the list and remembers it across reloads", async () => {
  using _now = vi.spyOn(Date, "now").mockReturnValue(NOW);
  localStorage.removeItem(ACTIVITY_LIST_SHOWN_KEY);
  using _storage = {
    [Symbol.dispose]: () => localStorage.removeItem(ACTIVITY_LIST_SHOWN_KEY),
  };
  {
    await using screen = await render(cards());
    const toggle = screen.getByTestId("activity-list-toggle");
    await expect.element(toggle).toHaveAttribute("aria-expanded", "true");
    await expect.element(screen.getByText("Thread started")).toBeInTheDocument();
    await userEvent.click(toggle);
    await expect.element(toggle).toHaveAttribute("aria-expanded", "false");
    await expect.element(toggle).toHaveFocus();
    await expect.element(screen.getByText("Thread started")).not.toBeInTheDocument();
  }
  await using screen = await render(cards());
  const toggle = screen.getByTestId("activity-list-toggle");
  await expect.element(toggle).toHaveAttribute("aria-expanded", "false");
  await expect.element(screen.getByText("Thread started")).not.toBeInTheDocument();
  await userEvent.click(toggle);
  await expect.element(screen.getByText("Thread started")).toBeInTheDocument();
});
