import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { RotateCcwIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { useResetInbox } from "../../state/inboxAgent";
import { isInboxClientThread } from "../../state/inboxAgent.logic";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** Icon button that resets a project's Inbox thread, used in the Inbox header and pane strip. */
export function InboxResetIconButton(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly threadId?: ThreadId | null | undefined;
  readonly projectDisplayName?: string | null | undefined;
  readonly className?: string | undefined;
}) {
  const { canReset, resetting, reset } = useResetInbox(
    { environmentId: props.environmentId, projectId: props.projectId },
    { projectDisplayName: props.projectDisplayName, threadId: props.threadId },
  );

  return (
    <Tooltip>
      <TooltipTrigger render={<span className="flex shrink-0" />}>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label="Reset Inbox"
          data-testid="inbox-reset-button"
          disabled={!canReset}
          onClick={() => void reset()}
          className={cn("shrink-0 [-webkit-app-region:no-drag]", props.className)}
        >
          <RotateCcwIcon aria-hidden className={cn("size-3.5", resetting && "animate-spin")} />
        </Button>
      </TooltipTrigger>
      <TooltipPopup side="bottom">{resetting ? "Resetting Inbox…" : "Reset Inbox"}</TooltipPopup>
    </Tooltip>
  );
}

/** Header control for full-page Inbox threads; renders nothing for ordinary threads. */
export function ChatInboxResetButton(props: {
  readonly thread:
    | (Parameters<typeof isInboxClientThread>[0] & {
        readonly environmentId: EnvironmentId;
        readonly projectId: ProjectId;
        readonly id: ThreadId;
      })
    | null
    | undefined;
  readonly projectDisplayName?: string | null | undefined;
}) {
  if (!props.thread || !isInboxClientThread(props.thread)) return null;
  return (
    <InboxResetIconButton
      environmentId={props.thread.environmentId}
      projectId={props.thread.projectId}
      threadId={props.thread.id}
      projectDisplayName={props.projectDisplayName}
      className="size-7 sm:size-7"
    />
  );
}
