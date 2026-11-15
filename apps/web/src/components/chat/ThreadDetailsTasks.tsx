import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";

import { useOpenLink } from "~/browser/useOpenLink";
import { useBoard, useBoardConnection } from "~/state/board";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import { threadBoardTasks } from "./threadDetailsTasks.logic";

/** The Board issues that link this thread, with their Linear status. */
export function ThreadDetailsTasks(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
}) {
  const threadRef = { environmentId: props.environmentId, threadId: props.threadId };
  const connection = useBoardConnection(props.environmentId);
  // Subscribing to the board starts the project's Linear poll, so wait for a sign-in.
  const snapshot = useBoard(
    props.environmentId,
    connection?.status === "connected" ? props.projectId : null,
  );
  const openLink = useOpenLink(threadRef);
  const tasks = threadBoardTasks(snapshot, threadRef);
  if (tasks.length === 0) return null;

  return (
    <ThreadDetailsSection headingId="thread-details-tasks-heading" title="Tasks">
      <ul aria-label="Linked Linear issues" className="m-0 list-none p-0">
        {tasks.map(({ issue, state }) => (
          <li key={issue.id} className="flex h-8 items-center rounded-lg">
            <Tooltip>
              <TooltipTrigger
                delay={200}
                render={
                  <ThreadDetailsControl
                    size="sm"
                    variant="ghost"
                    part="row"
                    onClick={(event) => void openLink(issue.url, { event }).catch(() => undefined)}
                  />
                }
              >
                <span
                  aria-hidden
                  className="size-2 shrink-0 rounded-full"
                  style={{ backgroundColor: state.color }}
                />
                <span className="shrink-0 text-2xs text-muted-foreground tabular-nums">
                  {issue.identifier}
                </span>
                <span className="min-w-0 flex-1 truncate text-left text-sm font-medium leading-4 text-foreground/85">
                  {issue.title}
                </span>
                <span className="max-w-1/3 shrink-0 truncate text-2xs text-muted-foreground">
                  {state.name}
                </span>
              </TooltipTrigger>
              <TooltipPopup side="left">
                <p className="font-medium">
                  {issue.identifier} {issue.title}
                </p>
                <p className="text-muted-foreground">Open in Linear</p>
              </TooltipPopup>
            </Tooltip>
          </li>
        ))}
      </ul>
    </ThreadDetailsSection>
  );
}
