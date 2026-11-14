import type {
  BoardColumn,
  BoardIssue,
  BoardPullRequest,
  BoardSnapshot,
  EnvironmentId,
  ProjectId,
  ScopedThreadRef,
} from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { useNavigate } from "@tanstack/react-router";
import { ExternalLinkIcon, Settings2Icon, SquareKanbanIcon } from "lucide-react";
import { type MouseEvent, useState } from "react";

import { useOpenLink } from "~/browser/useOpenLink";
import { resolvePullRequestTabLink } from "~/components/RightPanelTabs";
import { boardRefresh, useBoard } from "~/state/board";
import { useServerConfigs, useThreadShells } from "~/state/entities";
import { useAtomCommand } from "~/state/use-atom-command";
import { cn } from "~/lib/utils";
import {
  PullRequestLabelChip,
  pullRequestChecksStatePresentation,
  resolvePullRequestState,
} from "../pullRequest/pullRequestPresentation";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { RefreshIcon } from "../ui/refresh-icon";
import { Spinner } from "../ui/spinner";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  type BoardFilter,
  type BoardView,
  boardIssueTarget,
  boardPullRequestStatus,
  filterBoardColumns,
} from "./board.logic";

type ReadyBoard = Extract<BoardSnapshot, { status: "ready" }>;

interface CardContext {
  readonly environmentId: EnvironmentId;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly onOpen: (issue: BoardIssue, event: MouseEvent) => void;
}

/** The project's Linear board in the right panel. Read-only in this version. */
export default function BoardPanel(props: {
  readonly threadRef: ScopedThreadRef;
  readonly projectId: ProjectId | null;
}) {
  const environmentId = props.threadRef.environmentId;
  const snapshot = useBoard(environmentId, props.projectId);
  const refresh = useAtomCommand(boardRefresh);
  const [refreshing, setRefreshing] = useState(false);
  const [view, setView] = useState<BoardView>("board");
  const [filter, setFilter] = useState<BoardFilter>("all");
  const navigate = useNavigate();
  const openLink = useOpenLink(props.threadRef);
  const threads = useThreadShells();
  const configs = useServerConfigs();
  const connected = new Set(configs.keys());

  const onRefresh = async () => {
    if (props.projectId === null) return;
    setRefreshing(true);
    await refresh({ environmentId, input: { projectId: props.projectId } });
    setRefreshing(false);
  };
  const openSettings = (hash: "board" | "team-catalog") =>
    void navigate({ to: "/settings/threads", hash });
  const card: CardContext = {
    environmentId,
    threads,
    onOpen: (issue, event) => {
      const target = boardIssueTarget(issue, connected);
      if (target.kind === "thread") {
        void navigate({
          to: "/$environmentId/$threadId",
          params: { environmentId: target.ref.environmentId, threadId: target.ref.threadId },
        });
        return;
      }
      void openLink(target.url, { event }).catch(() => undefined);
    },
  };

  const refreshButton = (
    <Button
      size="sm"
      variant="outline"
      onClick={() => void onRefresh()}
      disabled={refreshing}
      aria-busy={refreshing}
    >
      <RefreshIcon size="sm" refreshing={refreshing} />
      Refresh
    </Button>
  );

  if (props.projectId === null) {
    return <BoardMessage title="No project" description="Open a project to see its board." />;
  }
  if (snapshot === null) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center">
        <Spinner />
      </div>
    );
  }
  switch (snapshot.status) {
    case "not-connected":
      return (
        <BoardMessage
          title="Connect Linear"
          description="The board shows the team project's Linear issues, read with your own Linear account. Add a personal API key in Settings."
        >
          <Button size="sm" variant="outline" onClick={() => openSettings("board")}>
            <Settings2Icon />
            Connect Linear
          </Button>
        </BoardMessage>
      );
    case "unconfigured":
      return (
        <UnconfiguredBoard
          snapshot={snapshot}
          refreshButton={refreshButton}
          openSettings={openSettings}
        />
      );
    case "failed":
      return (
        <BoardMessage
          title={failureTitle(snapshot.failure.reason)}
          description={snapshot.failure.detail}
        >
          {refreshButton}
          {snapshot.failure.reason === "unauthorized" ? (
            <Button size="sm" variant="outline" onClick={() => openSettings("board")}>
              <Settings2Icon />
              Reconnect Linear
            </Button>
          ) : null}
        </BoardMessage>
      );
    case "ready":
      return (
        <ReadyBoardView
          snapshot={snapshot}
          view={view}
          filter={filter}
          onViewChange={setView}
          onFilterChange={setFilter}
          refreshing={refreshing}
          onRefresh={() => void onRefresh()}
          onOpenLinear={(url, event) => void openLink(url, { event }).catch(() => undefined)}
          card={card}
        />
      );
  }
}

function failureTitle(reason: Extract<BoardSnapshot, { status: "failed" }>["failure"]["reason"]) {
  switch (reason) {
    case "unauthorized":
      return "Linear rejected your API key";
    case "team-not-found":
      return "Linear team not found";
    case "project-not-found":
      return "Linear project not found";
    case "rate-limited":
      return "Linear's rate limit was reached";
    case "unreachable":
      return "Could not reach Linear";
    case "invalid-response":
      return "Could not read the board";
  }
}

function BoardMessage(props: {
  readonly title: string;
  readonly description: React.ReactNode;
  readonly children?: React.ReactNode;
}) {
  return (
    <Empty className="scrollbar-gutter-both min-h-0 flex-1 justify-center-safe overflow-y-auto [&>*]:shrink-0">
      <EmptyMedia variant="icon">
        <SquareKanbanIcon />
      </EmptyMedia>
      <EmptyHeader>
        <EmptyTitle>{props.title}</EmptyTitle>
        <EmptyDescription>{props.description}</EmptyDescription>
      </EmptyHeader>
      {props.children ? (
        <div className="flex flex-wrap justify-center gap-2">{props.children}</div>
      ) : null}
    </Empty>
  );
}

function UnconfiguredBoard(props: {
  readonly snapshot: Extract<BoardSnapshot, { status: "unconfigured" }>;
  readonly refreshButton: React.ReactNode;
  readonly openSettings: (hash: "board" | "team-catalog") => void;
}) {
  const settingsButton = (
    <Button size="sm" variant="outline" onClick={() => props.openSettings("team-catalog")}>
      <Settings2Icon />
      Team projects settings
    </Button>
  );
  switch (props.snapshot.reason) {
    case "no-catalog":
      return (
        <BoardMessage
          title="No team catalog"
          description="A board belongs to a team project. Set up the team project catalog first."
        >
          {settingsButton}
        </BoardMessage>
      );
    case "not-in-catalog":
      return (
        <BoardMessage
          title="Not a team project"
          description="No project in the team catalog lists this project's repository."
        >
          {props.refreshButton}
          {settingsButton}
        </BoardMessage>
      );
    case "no-linear-team":
      return (
        <BoardMessage
          title="No Linear team for this project"
          description={
            <>
              Add the Linear team&apos;s key to{" "}
              <code className="font-mono text-xs">{props.snapshot.catalogFile}</code> in the team
              catalog, as <code className="font-mono text-xs">{'"linear": { "team": "KEY" }'}</code>
              , then refresh.
            </>
          }
        >
          {props.refreshButton}
        </BoardMessage>
      );
  }
}

function ReadyBoardView(props: {
  readonly snapshot: ReadyBoard;
  readonly view: BoardView;
  readonly filter: BoardFilter;
  readonly onViewChange: (view: BoardView) => void;
  readonly onFilterChange: (filter: BoardFilter) => void;
  readonly refreshing: boolean;
  readonly onRefresh: () => void;
  readonly onOpenLinear: (url: string, event: MouseEvent) => void;
  readonly card: CardContext;
}) {
  const { board, failure } = props.snapshot;
  const columns = filterBoardColumns(board.columns, props.filter);
  const total = columns.reduce((count, column) => count + column.issues.length, 0);
  const loaded = board.columns.reduce((count, column) => count + column.issues.length, 0);
  const linearUrl = board.project?.url ?? null;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
        <div className="min-w-0 flex-1 truncate text-sm font-medium">
          {board.team.name}
          {board.project ? (
            <span className="text-muted-foreground"> · {board.project.name}</span>
          ) : null}
        </div>
        <ToggleGroup
          aria-label="Board layout"
          value={[props.view]}
          onValueChange={(next) => {
            const value = next[0];
            if (value === "board" || value === "list") props.onViewChange(value);
          }}
        >
          <Toggle value="board">Board</Toggle>
          <Toggle value="list">List</Toggle>
        </ToggleGroup>
        <ToggleGroup
          aria-label="Show issues"
          value={[props.filter]}
          onValueChange={(next) => {
            const value = next[0];
            if (value === "all" || value === "mine") props.onFilterChange(value);
          }}
        >
          <Toggle value="all">All</Toggle>
          <Toggle value="mine">Mine</Toggle>
        </ToggleGroup>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label="Refresh board"
                disabled={props.refreshing}
                aria-busy={props.refreshing}
                onClick={props.onRefresh}
              >
                <RefreshIcon refreshing={props.refreshing} />
              </Button>
            }
          />
          <TooltipPopup>Refresh</TooltipPopup>
        </Tooltip>
        {linearUrl ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label="Open in Linear"
                  onClick={(event) => props.onOpenLinear(linearUrl, event)}
                >
                  <ExternalLinkIcon />
                </Button>
              }
            />
            <TooltipPopup>Open in Linear</TooltipPopup>
          </Tooltip>
        ) : null}
      </div>
      {failure ? (
        <div className="px-3 pt-2">
          <Alert variant="warning">
            <AlertDescription>
              Showing the board from {new Date(board.fetchedAt).toLocaleTimeString()}.{" "}
              {failure.detail}
            </AlertDescription>
          </Alert>
        </div>
      ) : null}
      {board.truncated ? (
        <p className="px-3 pt-2 text-xs text-muted-foreground">
          Showing the first {loaded} issues. Open Linear for the rest.
        </p>
      ) : null}
      {total === 0 ? (
        <BoardMessage
          title={props.filter === "mine" ? "Nothing assigned to you" : "No open issues"}
          description={
            props.filter === "mine"
              ? "No open issue on this board is assigned to you."
              : "This board has no open issues, and none closed in the last week."
          }
        />
      ) : props.view === "board" ? (
        <BoardColumns columns={columns} card={props.card} />
      ) : (
        <BoardList columns={columns} card={props.card} />
      )}
    </div>
  );
}

function StateDot({ color }: { readonly color: string }) {
  return (
    <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ backgroundColor: color }} />
  );
}

function BoardColumns(props: {
  readonly columns: ReadonlyArray<BoardColumn>;
  readonly card: CardContext;
}) {
  return (
    <div className="flex min-h-0 flex-1 gap-2 overflow-x-auto p-2">
      {props.columns.map((column) => (
        <section
          key={column.state.id}
          aria-label={column.state.name}
          className="flex min-h-0 w-64 shrink-0 flex-col rounded-lg bg-muted/40"
        >
          <header className="flex items-center gap-2 px-2.5 py-2 text-xs font-medium">
            <StateDot color={column.state.color} />
            <span className="truncate">{column.state.name}</span>
            <span className="text-muted-foreground">{column.issues.length}</span>
          </header>
          <ul className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto px-1.5 pb-1.5">
            {column.issues.map((issue) => (
              <li key={issue.id}>
                <BoardCard issue={issue} card={props.card} />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function BoardList(props: {
  readonly columns: ReadonlyArray<BoardColumn>;
  readonly card: CardContext;
}) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto pb-2">
      {props.columns
        .filter((column) => column.issues.length > 0)
        .map((column) => (
          <section key={column.state.id} aria-label={column.state.name}>
            <header className="sticky top-0 z-10 flex items-center gap-2 border-b bg-background px-3 py-1.5 text-xs font-medium">
              <StateDot color={column.state.color} />
              <span className="truncate">{column.state.name}</span>
              <span className="text-muted-foreground">{column.issues.length}</span>
            </header>
            <ul>
              {column.issues.map((issue) => (
                <li key={issue.id}>
                  <BoardRow issue={issue} card={props.card} />
                </li>
              ))}
            </ul>
          </section>
        ))}
    </div>
  );
}

function issueLabel(issue: BoardIssue) {
  return `${issue.identifier} ${issue.title}${issue.thread ? ", opens its thread" : ", opens in Linear"}`;
}

function BoardCard(props: { readonly issue: BoardIssue; readonly card: CardContext }) {
  const { issue } = props;
  return (
    <button
      type="button"
      aria-label={issueLabel(issue)}
      onClick={(event) => props.card.onOpen(issue, event)}
      className="flex w-full flex-col gap-1.5 rounded-md border bg-background p-2 text-left shadow-xs/5 hover:border-ring/40 focus-visible:outline-2 focus-visible:outline-ring"
    >
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="font-mono">{issue.identifier}</span>
        <span className="flex-1" />
        <Assignee issue={issue} />
      </div>
      <div className="line-clamp-2 text-sm">{issue.title}</div>
      <IssueMeta issue={issue} card={props.card} />
    </button>
  );
}

function BoardRow(props: { readonly issue: BoardIssue; readonly card: CardContext }) {
  const { issue } = props;
  return (
    <button
      type="button"
      aria-label={issueLabel(issue)}
      onClick={(event) => props.card.onOpen(issue, event)}
      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
    >
      <span className="w-16 shrink-0 truncate font-mono text-xs text-muted-foreground">
        {issue.identifier}
      </span>
      <span className="min-w-0 flex-1 truncate">{issue.title}</span>
      <IssueMeta issue={issue} card={props.card} inline />
      <Assignee issue={issue} />
    </button>
  );
}

function IssueMeta(props: {
  readonly issue: BoardIssue;
  readonly card: CardContext;
  readonly inline?: boolean;
}) {
  const { issue } = props;
  if (issue.labels.length === 0 && issue.pullRequests.length === 0) return null;
  return (
    <div
      className={cn(
        "flex min-w-0 flex-wrap items-center gap-1",
        props.inline && "shrink-0 flex-nowrap",
      )}
    >
      {issue.pullRequests.map((pullRequest) => (
        <PullRequestBadge key={pullRequest.url} pullRequest={pullRequest} card={props.card} />
      ))}
      {(props.inline ? issue.labels.slice(0, 2) : issue.labels).map((label) => (
        <PullRequestLabelChip key={label.id} label={{ name: label.name, color: label.color }} />
      ))}
    </div>
  );
}

function PullRequestBadge(props: {
  readonly pullRequest: BoardPullRequest;
  readonly card: CardContext;
}) {
  const { pullRequest } = props;
  const link = resolvePullRequestTabLink(
    props.card.threads,
    props.card.environmentId,
    pullRequest.host,
    pullRequest,
  );
  const status = boardPullRequestStatus(link?.snapshot, pullRequest.linearStatus);
  const presentation = status ? resolvePullRequestState(status) : null;
  const checks =
    status?.state === "open" && status.checksState
      ? pullRequestChecksStatePresentation(status.checksState)
      : null;
  const label = [`Pull request #${pullRequest.number}`, presentation?.label, checks?.label]
    .filter(Boolean)
    .join(", ");
  const Icon = presentation?.Icon;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            aria-label={label}
            className="inline-flex items-center gap-0.5 rounded-sm bg-muted px-1 text-2xs leading-4 text-muted-foreground"
          />
        }
      >
        {Icon ? <Icon aria-hidden className={cn("size-3", presentation.toneClassName)} /> : null}
        {`#${pullRequest.number}`}
        {checks ? <checks.Icon aria-hidden className={cn("size-3", checks.toneClassName)} /> : null}
      </TooltipTrigger>
      <TooltipPopup>{label}</TooltipPopup>
    </Tooltip>
  );
}

function Assignee({ issue }: { readonly issue: BoardIssue }) {
  const assignee = issue.assignee;
  if (assignee === null) return null;
  const initials = assignee.name
    .split(/\s+/)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          assignee.avatarUrl ? (
            <img
              src={assignee.avatarUrl}
              alt={assignee.name}
              className="size-4 shrink-0 rounded-full"
            />
          ) : (
            <span
              aria-label={assignee.name}
              className="flex size-4 shrink-0 items-center justify-center rounded-full bg-muted text-4xs font-medium text-muted-foreground"
            >
              {initials}
            </span>
          )
        }
      />
      <TooltipPopup>{assignee.name}</TooltipPopup>
    </Tooltip>
  );
}
