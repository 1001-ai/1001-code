import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, OrchestrationV2TurnItem } from "@t3tools/contracts";
import { ArrowUpRightIcon, CheckIcon, PlusIcon, SquareKanbanIcon } from "lucide-react";
import type { MouseEvent } from "react";

import { useOpenLink } from "~/browser/useOpenLink";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useBoardTeamKey, useOpenBoardIssueLink } from "./boardIssueLinks";
import { issueTeamKey } from "./boardIssueRefs.logic";
import { StatusIcon, UserAvatar } from "./boardParts";
import { boardStatusGlyph, boardTaskChangeOf } from "./boardTaskCard.logic";

// The thread details card's `dropdown-glass` fill (18% popover over 80% glass) and outline, no blur.
const SURFACE = "border border-foreground/10 bg-popover/84";

/** The card an agent's `save_issue`, `board_add` or `board_update` call leaves when it files, takes or moves a task. */
export function BoardTaskCard(props: {
  readonly environmentId: EnvironmentId;
  readonly item: Extract<OrchestrationV2TurnItem, { type: "dynamic_tool" }>;
}) {
  const threadRef = scopeThreadRef(props.environmentId, props.item.threadId);
  const openLink = useOpenLink(threadRef);
  const openBoardIssueLink = useOpenBoardIssueLink(threadRef);
  const boardTeamKey = useBoardTeamKey(threadRef);
  const change = boardTaskChangeOf(props.item);
  if (change === null) return null;

  const status = <StatusIcon glyph={boardStatusGlyph(change.statusType, change.status)} />;
  if (change.kind === "status") {
    return (
      <div
        data-v2-item-type="board-task"
        className={cn(
          SURFACE,
          "flex w-fit max-w-full min-w-0 items-center gap-2 rounded-full py-1.5 pr-2.5 pl-3 text-xs text-muted-foreground",
        )}
      >
        {status}
        <span className="shrink-0 font-mono">{change.identifier}</span>
        <span className="truncate font-medium text-foreground">{change.status}</span>
      </div>
    );
  }

  const openInLinear = (event: MouseEvent) =>
    void openLink(change.url, { event }).catch(() => undefined);
  const KickerIcon = change.kind === "created" ? PlusIcon : CheckIcon;
  return (
    <div
      data-v2-item-type="board-task"
      className={cn(SURFACE, "flex min-w-0 flex-col gap-2 rounded-2xl py-3 pr-3 pl-4")}
    >
      <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
        <span className="inline-flex shrink-0 items-center gap-1.5 font-medium text-foreground">
          <KickerIcon aria-hidden className="size-3" />
          {change.kind === "created" ? "New task" : "Picked up"}
        </span>
        <span aria-hidden>·</span>
        <span className="shrink-0 font-mono">{change.identifier}</span>
        {change.project === undefined ? null : (
          <>
            <span aria-hidden>·</span>
            <span className="truncate">{change.project}</span>
          </>
        )}
      </div>
      <div className="text-sm font-medium [overflow-wrap:anywhere]">{change.title}</div>
      <div className="flex min-w-0 items-center gap-3 text-xs text-muted-foreground">
        <span className="inline-flex h-5.5 shrink-0 items-center gap-1.5 rounded-full bg-foreground/7 pr-2 pl-1.5 text-foreground">
          {status}
          {change.status}
        </span>
        {change.assignee === undefined ? null : (
          <span className="inline-flex min-w-0 items-center gap-1.5">
            <UserAvatar
              large
              user={{
                id: change.assigneeId ?? change.assignee,
                name: change.assignee,
                avatarUrl: null,
                isMe: false,
              }}
            />
            <span className="truncate">{change.assignee}</span>
          </span>
        )}
        <span className="flex-1" />
        <span className="flex shrink-0 items-center gap-0.5">
          {boardTeamKey !== null && issueTeamKey(change.identifier) === boardTeamKey ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-xs"
                    variant="ghost-muted"
                    aria-label="Open in Board"
                    onClick={(event) => {
                      if (!openBoardIssueLink(event, change.url)) openInLinear(event);
                    }}
                  />
                }
              >
                <SquareKanbanIcon />
              </TooltipTrigger>
              <TooltipPopup>Open in Board</TooltipPopup>
            </Tooltip>
          ) : null}
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="ghost-muted"
                  aria-label="Open in Linear"
                  onClick={openInLinear}
                />
              }
            >
              <ArrowUpRightIcon />
            </TooltipTrigger>
            <TooltipPopup>Open in Linear</TooltipPopup>
          </Tooltip>
        </span>
      </div>
    </div>
  );
}
