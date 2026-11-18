import type { EnvironmentId, ScheduledTaskId, ScopedThreadRef } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { CalendarClockIcon } from "lucide-react";

import { useQuietThreadShell } from "../state/entities";
import { useEnvironmentQuery } from "../state/query";
import { serverEnvironment } from "../state/server";
import { cn } from "~/lib/utils";
import { Badge } from "./ui/badge";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

interface StartedByAutomationProps {
  readonly environmentId: EnvironmentId;
  readonly scheduledTaskId: ScheduledTaskId;
}

/** The automation's title, or undefined while its list is not loaded or once it is deleted. */
function useAutomationTitle({ environmentId, scheduledTaskId }: StartedByAutomationProps) {
  const tasks = useEnvironmentQuery(
    serverEnvironment.scheduledTasksLive({ environmentId, input: {} }),
  );
  return tasks.data?.tasks.find((task) => task.id === scheduledTaskId)?.title;
}

export function StartedByAutomationIcon() {
  return <CalendarClockIcon aria-hidden className="size-3 shrink-0 text-secondary-label" />;
}

// Reads the automation list itself, so a list update re-renders this name and not its sidebar row.
function AutomationName(props: StartedByAutomationProps) {
  return useAutomationTitle(props) ?? "Automation";
}

/** A sidebar row's meta line for a thread an automation started: the icon and the automation's name. */
export function StartedByAutomationLabel(props: StartedByAutomationProps) {
  return (
    <>
      <CalendarClockIcon aria-hidden className="size-3 shrink-0" />
      <span className="min-w-0 flex-1 truncate">
        <AutomationName {...props} />
      </span>
    </>
  );
}

// Narrow headers drop "Started by automation", then the name, so the chip never crowds out the title.
function StartedByAutomationChip(props: StartedByAutomationProps) {
  const title = useAutomationTitle(props);
  const label = (
    <>
      <CalendarClockIcon aria-hidden />
      <span className="@max-[34rem]/thread-header:hidden">
        {title === undefined ? "Started by automation" : "Started by automation ·"}
      </span>
      <span
        className={cn(
          "max-w-48 truncate @max-[22rem]/thread-header:hidden",
          title === undefined && "@min-[34rem]/thread-header:hidden",
        )}
      >
        {title ?? "Automation"}
      </span>
    </>
  );
  if (title === undefined) {
    return (
      <Tooltip>
        <TooltipTrigger
          render={<Badge variant="outline" size="sm" aria-label="Started by automation" />}
        >
          {label}
        </TooltipTrigger>
        <TooltipPopup side="top">An automation started this thread.</TooltipPopup>
      </Tooltip>
    );
  }
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Badge
            variant="outline"
            size="sm"
            aria-label={`Started by automation: ${title}`}
            render={
              <Link
                to="/settings/scheduled-tasks"
                search={{ environmentId: props.environmentId, taskId: props.scheduledTaskId }}
              />
            }
          />
        }
      >
        {label}
      </TooltipTrigger>
      <TooltipPopup side="top">Started by the automation “{title}”. Click to open it.</TooltipPopup>
    </Tooltip>
  );
}

/** The thread header's chip for a thread an automation started; nothing for any other thread. */
export function StartedByAutomationBadge(props: { threadRef: ScopedThreadRef }) {
  // The quiet shell holds still while the thread streams, and who started a thread never changes.
  const scheduledTaskId = useQuietThreadShell(props.threadRef)?.startedByScheduledTaskId;
  return scheduledTaskId === undefined ? null : (
    <StartedByAutomationChip
      environmentId={props.threadRef.environmentId}
      scheduledTaskId={scheduledTaskId}
    />
  );
}
