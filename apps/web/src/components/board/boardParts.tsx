import type {
  BoardPriority,
  BoardPullRequest,
  BoardThreadLink,
  BoardUser,
  EnvironmentId,
} from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { Link } from "@tanstack/react-router";
import { MessagesSquareIcon, MonitorOffIcon } from "lucide-react";
import type { MouseEvent } from "react";

import { resolvePullRequestTabLink } from "~/components/RightPanelTabs";
import { resolveSidebarThreadStatus, type SidebarThreadStatus } from "~/components/Sidebar.logic";
import { RelativeTime } from "~/components/RelativeTime";
import { useQuietThreadShell, useQuietThreadShells } from "~/state/entities";
import { cn } from "~/lib/utils";
import {
  pullRequestChecksStatePresentation,
  resolvePullRequestState,
} from "../pullRequest/pullRequestPresentation";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { BOARD_PRIORITY_LABELS, boardPullRequestStatus, boardThreadTarget } from "./board.logic";
import type { BoardStatusGlyph } from "./boardTaskCard.logic";

export function StateDot({ color }: { readonly color: string }) {
  return (
    <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ backgroundColor: color }} />
  );
}

/** Linear's status icon for a workflow state. */
export function StatusIcon(props: { readonly glyph: BoardStatusGlyph }) {
  const ring = (className: string, dashed = false) => (
    <circle
      cx="8"
      cy="8"
      r="6.25"
      fill="none"
      strokeWidth="1.5"
      strokeDasharray={dashed ? "2.1 2" : undefined}
      className={className}
    />
  );
  return (
    <svg viewBox="0 0 16 16" aria-hidden className="size-3.5 shrink-0">
      {props.glyph === "backlog" ? ring("stroke-muted-foreground", true) : null}
      {props.glyph === "unstarted" ? ring("stroke-muted-foreground") : null}
      {props.glyph === "started" ? (
        <>
          {ring("stroke-warning")}
          <path d="M8 8V4.25A3.75 3.75 0 0 1 8 11.75Z" className="fill-warning" />
        </>
      ) : null}
      {props.glyph === "review" ? (
        <>
          {ring("stroke-success")}
          <path d="M8 8V4.25A3.75 3.75 0 1 1 4.25 8Z" className="fill-success" />
        </>
      ) : null}
      {props.glyph === "completed" ? (
        <>
          <circle cx="8" cy="8" r="7" className="fill-info" />
          <path
            d="M5 8.2l2 2 4-4.2"
            fill="none"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="stroke-background"
          />
        </>
      ) : null}
      {props.glyph === "canceled" ? (
        <>
          <circle cx="8" cy="8" r="7" className="fill-muted-foreground" />
          <path
            d="M5.75 5.75l4.5 4.5M10.25 5.75l-4.5 4.5"
            fill="none"
            strokeWidth="1.6"
            strokeLinecap="round"
            className="stroke-background"
          />
        </>
      ) : null}
    </svg>
  );
}

export function UserAvatar(props: { readonly user: BoardUser; readonly large?: boolean }) {
  const size = props.large ? "size-5" : "size-4";
  if (props.user.avatarUrl) {
    return (
      <img
        src={props.user.avatarUrl}
        alt={props.user.name}
        className={cn(size, "shrink-0 rounded-full")}
      />
    );
  }
  const initials = props.user.name
    .split(/\s+/)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
  return (
    <span
      aria-label={props.user.name}
      className={cn(
        size,
        "flex shrink-0 items-center justify-center rounded-full bg-foreground/15 text-4xs font-semibold text-foreground",
      )}
    >
      {initials}
    </span>
  );
}

export function Assignee(props: { readonly assignee: BoardUser | null }) {
  if (props.assignee === null) return null;
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="relative inline-flex shrink-0" />}>
        <UserAvatar user={props.assignee} />
      </TooltipTrigger>
      <TooltipPopup>{props.assignee.name}</TooltipPopup>
    </Tooltip>
  );
}

/** Linear's priority icons: bars by level, an orange box for urgent. */
export function PriorityGlyph(props: { readonly priority: BoardPriority }) {
  const { priority } = props;
  if (priority === 0) return null;
  const label = BOARD_PRIORITY_LABELS[priority];
  if (priority === 1) {
    return (
      <svg viewBox="0 0 16 16" role="img" aria-label={label} className="size-3.5 shrink-0">
        <rect x="1" y="1" width="14" height="14" rx="3" className="fill-warning" />
        <path d="M8 4.2v4.6" className="stroke-white" strokeWidth="1.8" strokeLinecap="round" />
        <circle cx="8" cy="11.4" r="1" className="fill-white" />
      </svg>
    );
  }
  const filled = 5 - priority;
  return (
    <svg
      viewBox="0 0 16 16"
      role="img"
      aria-label={label}
      className="size-3.5 shrink-0 fill-muted-foreground"
    >
      {[0, 1, 2].map((bar) => (
        <rect
          key={bar}
          x={1.5 + bar * 5}
          y={8 - bar * 3}
          width="3"
          height={6 + bar * 3}
          rx="1"
          opacity={bar < filled ? 1 : 0.3}
        />
      ))}
    </svg>
  );
}

/** T3 Code's tracked state for the pull request when a thread has it, else Linear's. */
export function useBoardPullRequest(pullRequest: BoardPullRequest, environmentId: EnvironmentId) {
  const threads = useQuietThreadShells();
  const link = resolvePullRequestTabLink(threads, environmentId, pullRequest.host, pullRequest);
  const status = boardPullRequestStatus(link?.snapshot, pullRequest.linearStatus);
  const presentation = status ? resolvePullRequestState(status) : null;
  const checks =
    status?.state === "open" && status.checksState
      ? pullRequestChecksStatePresentation(status.checksState)
      : null;
  const label = [`Pull request #${pullRequest.number}`, presentation?.label, checks?.label]
    .filter(Boolean)
    .join(", ");
  return { title: link?.snapshot?.title ?? null, presentation, checks, label };
}

export function PullRequestBadge(props: {
  readonly pullRequest: BoardPullRequest;
  readonly environmentId: EnvironmentId;
}) {
  const { presentation, checks, label } = useBoardPullRequest(
    props.pullRequest,
    props.environmentId,
  );
  const Icon = presentation?.Icon;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            aria-label={label}
            className="relative inline-flex shrink-0 items-center gap-0.5 rounded-sm bg-muted px-1 text-2xs leading-4 text-muted-foreground"
          />
        }
      >
        {Icon ? <Icon aria-hidden className={cn("size-3", presentation.toneClassName)} /> : null}
        {`#${props.pullRequest.number}`}
        {checks ? <checks.Icon aria-hidden className={cn("size-3", checks.toneClassName)} /> : null}
      </TooltipTrigger>
      <TooltipPopup>{label}</TooltipPopup>
    </Tooltip>
  );
}

interface ThreadStatusPresentation {
  readonly label: string;
  readonly colorClass: string;
  readonly dotClass: string;
}

const THREAD_STATUS: Record<SidebarThreadStatus, ThreadStatusPresentation> = {
  approval: { label: "Approval", colorClass: "text-warning-foreground", dotClass: "bg-warning" },
  input: {
    label: "Input",
    colorClass: "text-indigo-600 dark:text-indigo-300",
    dotClass: "bg-indigo-600 dark:bg-indigo-300",
  },
  request: { label: "Request", colorClass: "text-guest-foreground", dotClass: "bg-guest" },
  preparing: { label: "Setting up", colorClass: "text-info-foreground", dotClass: "bg-info" },
  working: { label: "Working", colorClass: "text-info-foreground", dotClass: "bg-info" },
  waiting: {
    label: "Waiting",
    colorClass: "text-muted-foreground",
    dotClass: "bg-muted-foreground",
  },
  failed: { label: "Failed", colorClass: "text-error-foreground", dotClass: "bg-error" },
  limited: { label: "Limited", colorClass: "text-warning-foreground", dotClass: "bg-warning" },
  ready: {
    label: "Idle",
    colorClass: "text-muted-foreground",
    dotClass: "border-[1.5px] border-muted-foreground/60",
  },
};

function threadStatusPresentation(shell: EnvironmentThreadShell): ThreadStatusPresentation {
  return THREAD_STATUS[resolveSidebarThreadStatus(shell)];
}

export function ThreadStatusDot(props: { readonly status: ThreadStatusPresentation }) {
  return (
    <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", props.status.dotClass)} />
  );
}

/** The linked thread's live shell when this client reaches its environment. */
export function useBoardThread(
  link: BoardThreadLink,
  connectedEnvironmentIds: ReadonlySet<EnvironmentId>,
) {
  const target = boardThreadTarget(link, connectedEnvironmentIds);
  const shell = useQuietThreadShell(target.kind === "thread" ? target.ref : null);
  return {
    target,
    title: shell?.title.trim() || "Thread",
    status: shell ? threadStatusPresentation(shell) : null,
  };
}

export function LinkedBy(props: { readonly link: BoardThreadLink }) {
  return (
    <>
      {props.link.linkedBy ? `Linked by ${props.link.linkedBy.name} ` : "Linked "}
      <RelativeTime timestamp={props.link.linkedAt} />
    </>
  );
}

const CHIP =
  "flex h-5.5 min-w-0 items-center gap-1.5 rounded-sm px-1.5 text-2xs no-underline focus-visible:outline-2 focus-visible:outline-ring";

/** The card's thread: live status and title, or the way to the issue when it is out of reach. */
export function BoardThreadChip(props: {
  readonly link: BoardThreadLink;
  readonly more: number;
  readonly compact?: boolean;
  readonly connectedEnvironmentIds: ReadonlySet<EnvironmentId>;
  readonly onOpenLinear: (event: MouseEvent) => void;
}) {
  const { target, title, status } = useBoardThread(props.link, props.connectedEnvironmentIds);
  const moreLabel = `${props.more} more ${props.more === 1 ? "thread" : "threads"}, listed in the issue details`;
  const more =
    props.more > 0 ? (
      <Tooltip>
        <TooltipTrigger
          render={
            <span
              aria-label={moreLabel}
              className="relative shrink-0 rounded-sm bg-muted px-1 text-4xs leading-4 font-medium text-muted-foreground"
            />
          }
        >
          +{props.more}
        </TooltipTrigger>
        <TooltipPopup>{moreLabel}</TooltipPopup>
      </Tooltip>
    ) : null;
  if (target.kind === "unreachable") {
    return (
      <>
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label="Thread on another machine, opens the issue in Linear"
                onClick={props.onOpenLinear}
                className={cn(
                  CHIP,
                  "relative text-muted-foreground hover:bg-accent",
                  props.compact ? "max-w-32 bg-muted" : "flex-1",
                )}
              />
            }
          >
            <MonitorOffIcon aria-hidden className="size-3 shrink-0 text-muted-foreground/70" />
            <span className="truncate">
              {props.compact ? "Another machine" : "Thread on another machine"}
            </span>
          </TooltipTrigger>
          <TooltipPopup>
            <div>Thread on another machine</div>
            <div className="text-muted-foreground">
              This app is not connected to it. <LinkedBy link={props.link} />. Select to open the
              issue in Linear.
            </div>
          </TooltipPopup>
        </Tooltip>
        {more}
      </>
    );
  }
  const statusLabel = status?.label ?? "Status unknown";
  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <Link
              to="/$environmentId/$threadId"
              params={{ environmentId: target.ref.environmentId, threadId: target.ref.threadId }}
              aria-label={`Open thread ${title}, ${statusLabel}`}
              className={cn(
                CHIP,
                "relative text-foreground hover:bg-accent",
                props.compact ? "max-w-32 bg-muted" : "flex-1",
              )}
            />
          }
        >
          {status ? (
            <ThreadStatusDot status={status} />
          ) : (
            <MessagesSquareIcon aria-hidden className="size-3 shrink-0 text-muted-foreground" />
          )}
          {status && !props.compact ? (
            <span className={cn("shrink-0 font-medium", status.colorClass)}>{status.label}</span>
          ) : null}
          <span className="min-w-0 truncate text-foreground/80">{title}</span>
        </TooltipTrigger>
        <TooltipPopup>{status ? `${status.label} · open thread` : "Open thread"}</TooltipPopup>
      </Tooltip>
      {more}
    </>
  );
}
