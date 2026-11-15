import type {
  BoardIssue,
  BoardPullRequest,
  BoardThreadLink,
  BoardWorkflowState,
  EnvironmentId,
  ProjectId,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  ExternalLinkIcon,
  MessagesSquareIcon,
  MonitorOffIcon,
} from "lucide-react";
import { AsyncResult } from "effect/reactivity";
import type { MouseEvent } from "react";

import ChatMarkdown from "~/components/ChatMarkdown";
import { RelativeTime } from "~/components/RelativeTime";
import { useBoardIssueDetail } from "~/state/board";
import { formatEnvironmentQueryError } from "~/state/query";
import { cn } from "~/lib/utils";
import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import { PullRequestLabelChip } from "../pullRequest/pullRequestPresentation";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { BOARD_PRIORITY_LABELS } from "./board.logic";
import {
  LinkedBy,
  PriorityGlyph,
  StateDot,
  ThreadStatusDot,
  UserAvatar,
  useBoardPullRequest,
  useBoardThread,
} from "./boardParts";

/** One issue in the board's place: what the card shows, every linked thread, the description. */
export function BoardIssueDetail(props: {
  readonly issue: BoardIssue;
  readonly state: BoardWorkflowState;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly threadRef: ScopedThreadRef;
  readonly connectedEnvironmentIds: ReadonlySet<EnvironmentId>;
  readonly onBack: () => void;
  readonly onOpenUrl: (url: string, event: MouseEvent) => void;
}) {
  const { issue } = props;
  const openIssue = (event: MouseEvent) => props.onOpenUrl(issue.url, event);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <Button size="sm" variant="ghost" data-board-back onClick={props.onBack}>
          <ChevronLeftIcon />
          Board
        </Button>
        <span className="flex-1" />
        <Button size="sm" variant="outline" onClick={openIssue}>
          <ExternalLinkIcon />
          Open in Linear
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pt-3.5 pb-5">
        <div className="font-mono text-xs text-muted-foreground">{issue.identifier}</div>
        <h2 className="mt-1 mb-3 text-base font-semibold">{issue.title}</h2>
        <dl className="grid grid-cols-[5rem_1fr] gap-x-2.5 gap-y-1.5 text-xs leading-5">
          <dt className="text-muted-foreground">Status</dt>
          <dd className="flex items-center gap-1.5">
            <StateDot color={props.state.color} />
            {props.state.name}
          </dd>
          <dt className="text-muted-foreground">Priority</dt>
          <dd className="flex items-center gap-1.5">
            <PriorityGlyph priority={issue.priority} />
            {BOARD_PRIORITY_LABELS[issue.priority]}
          </dd>
          <dt className="text-muted-foreground">Assignee</dt>
          <dd className="flex items-center gap-1.5">
            {issue.assignee ? (
              <>
                <UserAvatar user={issue.assignee} large />
                {issue.assignee.name}
              </>
            ) : (
              <span className="text-muted-foreground">Unassigned</span>
            )}
          </dd>
          {issue.labels.length > 0 ? (
            <>
              <dt className="text-muted-foreground">Labels</dt>
              <dd className="flex min-w-0 flex-wrap items-center gap-1">
                {issue.labels.map((label) => (
                  <PullRequestLabelChip key={label.id} label={label} />
                ))}
              </dd>
            </>
          ) : null}
        </dl>
        {issue.threads.length > 0 ? (
          <DetailSection icon={<MessagesSquareIcon />} title="Threads" count={issue.threads.length}>
            {issue.threads.map((link) => (
              <ThreadItem
                key={`${link.environmentId}/${link.threadId}`}
                link={link}
                connectedEnvironmentIds={props.connectedEnvironmentIds}
              />
            ))}
          </DetailSection>
        ) : null}
        {issue.pullRequests.length > 0 ? (
          <DetailSection
            icon={<PullRequestGlyph.pullRequest />}
            title="Pull requests"
            count={issue.pullRequests.length}
          >
            {issue.pullRequests.map((pullRequest) => (
              <PullRequestItem
                key={pullRequest.url}
                pullRequest={pullRequest}
                environmentId={props.environmentId}
                onOpen={(event) => props.onOpenUrl(pullRequest.url, event)}
              />
            ))}
          </DetailSection>
        ) : null}
        <Description
          environmentId={props.environmentId}
          projectId={props.projectId}
          threadRef={props.threadRef}
          issue={issue}
        />
      </div>
    </div>
  );
}

function DetailSection(props: {
  readonly icon: React.ReactNode;
  readonly title: string;
  readonly count: number;
  readonly children: React.ReactNode;
}) {
  return (
    <section aria-label={props.title} className="mt-4">
      <h3 className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-muted-foreground [&_svg]:size-3.5">
        {props.icon}
        {props.title}
        <span>{props.count}</span>
      </h3>
      <ul className="divide-y overflow-hidden rounded-lg border bg-card">{props.children}</ul>
    </section>
  );
}

const ITEM =
  "flex w-full items-start gap-2 px-2.5 py-1.5 text-left text-sm no-underline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring";

function ThreadItem(props: {
  readonly link: BoardThreadLink;
  readonly connectedEnvironmentIds: ReadonlySet<EnvironmentId>;
}) {
  const { target, title, status } = useBoardThread(props.link, props.connectedEnvironmentIds);
  if (target.kind === "unreachable") {
    return (
      <li className={cn(ITEM, "text-muted-foreground")}>
        <MonitorOffIcon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
        <span className="min-w-0 flex-1">
          <span className="block truncate">Thread on another machine</span>
          <span className="block text-2xs">
            <LinkedBy link={props.link} /> · not connected
          </span>
        </span>
      </li>
    );
  }
  return (
    <li>
      <Link
        to="/$environmentId/$threadId"
        params={{ environmentId: target.ref.environmentId, threadId: target.ref.threadId }}
        aria-label={`Open thread ${title}${status ? `, ${status.label}` : ""}`}
        className={cn(ITEM, "text-foreground hover:bg-muted")}
      >
        <span className="flex h-4.5 shrink-0 items-center">
          {status ? (
            <ThreadStatusDot status={status} />
          ) : (
            <MessagesSquareIcon aria-hidden className="size-3.5 text-muted-foreground" />
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="min-w-0 flex-1 truncate">{title}</span>
            {status ? (
              <span className={cn("shrink-0 text-2xs font-medium", status.colorClass)}>
                {status.label}
              </span>
            ) : null}
          </span>
          <span className="block text-2xs text-muted-foreground">
            <LinkedBy link={props.link} />
          </span>
        </span>
        <ChevronRightIcon aria-hidden className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
      </Link>
    </li>
  );
}

function PullRequestItem(props: {
  readonly pullRequest: BoardPullRequest;
  readonly environmentId: EnvironmentId;
  readonly onOpen: (event: MouseEvent) => void;
}) {
  const { pullRequest } = props;
  const { title, presentation, checks, label } = useBoardPullRequest(
    pullRequest,
    props.environmentId,
  );
  const Icon = presentation?.Icon ?? PullRequestGlyph.pullRequest;
  return (
    <li>
      <button
        type="button"
        aria-label={`${label}, opens it`}
        onClick={props.onOpen}
        className={cn(ITEM, "hover:bg-muted")}
      >
        <Icon aria-hidden className={cn("mt-0.5 size-3.5 shrink-0", presentation?.toneClassName)} />
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="min-w-0 flex-1 truncate">
              #{pullRequest.number}
              {title ? ` ${title}` : null}
            </span>
            {checks ? (
              <span className={cn("shrink-0 text-2xs font-medium", checks.toneClassName)}>
                {checks.label}
              </span>
            ) : null}
          </span>
          <span className="block text-2xs text-muted-foreground">
            {presentation ? `${presentation.label} · ` : null}
            {pullRequest.repository}
          </span>
        </span>
      </button>
    </li>
  );
}

function Description(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly threadRef: ScopedThreadRef;
  readonly issue: BoardIssue;
}) {
  const result = useBoardIssueDetail(props.environmentId, props.projectId, props.issue.id);
  const detail = AsyncResult.getOrElse(result, () => null);
  const { issue } = props;
  return (
    <>
      <section aria-label="Description" className="mt-4">
        <h3 className="mb-1.5 text-xs font-medium text-muted-foreground">Description</h3>
        {detail === null && result._tag === "Failure" ? (
          <p className="text-xs text-muted-foreground">
            Could not read the description. {formatEnvironmentQueryError(result.cause)}
          </p>
        ) : detail === null ? (
          <Spinner />
        ) : detail.description?.trim() ? (
          <ChatMarkdown
            text={detail.description}
            cwd={undefined}
            environmentId={props.environmentId}
            threadRef={props.threadRef}
          />
        ) : (
          <p className="text-xs text-muted-foreground">No description.</p>
        )}
      </section>
      <p className="mt-3.5 border-t pt-2.5 text-2xs text-muted-foreground">
        Created <RelativeTime timestamp={issue.createdAt} />
        {detail?.creator ? ` by ${detail.creator.name}` : null}
        {issue.startedAt ? (
          <>
            {" · Started "}
            <RelativeTime timestamp={issue.startedAt} />
          </>
        ) : null}
        {" · Updated "}
        <RelativeTime timestamp={issue.updatedAt} />
      </p>
    </>
  );
}
