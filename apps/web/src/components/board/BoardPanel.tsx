import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type {
  BoardColumn,
  BoardIssue,
  BoardSnapshot,
  EnvironmentId,
  ProjectId,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ExternalLinkIcon, Settings2Icon, SquareKanbanIcon } from "lucide-react";
import { type MouseEvent, useRef, useState } from "react";
import { flushSync } from "react-dom";

import { useOpenLink } from "~/browser/useOpenLink";
import { RelativeTime } from "~/components/RelativeTime";
import { boardRefresh, useBoard } from "~/state/board";
import { useServerConfigs } from "~/state/entities";
import { useAtomCommand } from "~/state/use-atom-command";
import { cn } from "~/lib/utils";
import { PullRequestLabelChip } from "../pullRequest/pullRequestPresentation";
import { Alert, AlertAction, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { RefreshIcon } from "../ui/refresh-icon";
import { Spinner } from "../ui/spinner";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  type BoardFilter,
  type BoardView,
  boardCardThread,
  boardIssueTime,
  filterBoardColumns,
} from "./board.logic";
import { BoardIssueDetail } from "./BoardIssueDetail";
import { boardOpenIssueView } from "./boardIssueRefs.logic";
import { type BoardOpenIssue, useBoardOpenIssueStore } from "./boardOpenIssueStore";
import { Assignee, BoardThreadChip, PriorityGlyph, PullRequestBadge, StateDot } from "./boardParts";

type ReadyBoard = Extract<BoardSnapshot, { status: "ready" }>;

interface CardContext {
  readonly environmentId: EnvironmentId;
  readonly connectedEnvironmentIds: ReadonlySet<EnvironmentId>;
  readonly onOpenIssue: (issueId: string) => void;
  readonly onOpenUrl: (url: string, event: MouseEvent) => void;
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
  const threadKey = scopedThreadKey(props.threadRef);
  const openIssue = useBoardOpenIssueStore((state) => state.byThreadKey[threadKey] ?? null);
  const setOpenIssue = (issue: BoardOpenIssue | null) =>
    useBoardOpenIssueStore.getState().setOpenIssue(threadKey, issue);
  const ready = snapshot?.status === "ready";
  const { open, note } = boardOpenIssueView(
    snapshot?.status === "ready" ? snapshot.board.columns : null,
    openIssue,
  );
  const panelRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const openLink = useOpenLink(props.threadRef);
  const configs = useServerConfigs();
  const connectedEnvironmentIds = new Set(configs.keys());

  const onRefresh = async () => {
    if (props.projectId === null) return;
    setRefreshing(true);
    await refresh({ environmentId, input: { projectId: props.projectId } });
    setRefreshing(false);
  };
  const openSettings = (hash: "board" | "team-catalog") =>
    void navigate({ to: "/settings/threads", hash });
  const onOpenUrl = (url: string, event: MouseEvent) =>
    void openLink(url, { event }).catch(() => undefined);
  const focusIn = (selector: string) =>
    panelRef.current?.querySelector<HTMLElement>(selector)?.focus();
  const onOpenIssue = (issueId: string) => {
    flushSync(() => setOpenIssue({ issue: issueId, fromOutside: false, linearUrl: null }));
    focusIn("[data-board-back]");
  };
  const onBack = () => {
    const issueId = open?.issue.id ?? null;
    flushSync(() => setOpenIssue(null));
    if (issueId !== null) focusIn(`[data-board-issue="${CSS.escape(issueId)}"]`);
  };
  const card: CardContext = {
    environmentId,
    connectedEnvironmentIds,
    onOpenIssue,
    onOpenUrl,
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

  // An issue opened from outside that the board cannot show says so, and offers Linear.
  const noteLinearUrl = note?.linearUrl ?? null;
  const noteElement =
    note === null ? null : (
      <div className="px-3 pt-2">
        <Alert variant="info">
          <AlertDescription>
            {ready
              ? `${note.identifier} is not on this board.`
              : `${note.identifier} cannot be shown while the board is unavailable.`}
          </AlertDescription>
          <AlertAction>
            {noteLinearUrl !== null ? (
              <Button
                size="xs"
                variant="outline"
                onClick={(event) => onOpenUrl(noteLinearUrl, event)}
              >
                <ExternalLinkIcon />
                Open in Linear
              </Button>
            ) : null}
            <Button size="xs" variant="ghost" onClick={() => setOpenIssue(null)}>
              Dismiss
            </Button>
          </AlertAction>
        </Alert>
      </div>
    );
  const withNote = (message: React.ReactNode) =>
    noteElement === null ? (
      message
    ) : (
      <div className="flex min-h-0 flex-1 flex-col">
        {noteElement}
        {message}
      </div>
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
      return withNote(
        <BoardMessage
          title="Sign in to Linear"
          description="The board shows the team project's Linear issues, read with your own Linear account. Sign in to Linear in Settings."
        >
          <Button size="sm" variant="outline" onClick={() => openSettings("board")}>
            <Settings2Icon />
            Sign in to Linear
          </Button>
        </BoardMessage>,
      );
    case "unconfigured":
      return withNote(
        <UnconfiguredBoard
          snapshot={snapshot}
          refreshButton={refreshButton}
          openSettings={openSettings}
        />,
      );
    case "failed":
      return withNote(
        <BoardMessage
          title={failureTitle(snapshot.failure.reason)}
          description={snapshot.failure.detail}
        >
          {refreshButton}
          {snapshot.failure.reason === "unauthorized" ? (
            <Button size="sm" variant="outline" onClick={() => openSettings("board")}>
              <Settings2Icon />
              Sign in to Linear again
            </Button>
          ) : null}
        </BoardMessage>,
      );
    case "ready": {
      return (
        <div ref={panelRef} className="flex min-h-0 flex-1 flex-col">
          {open !== null ? (
            <BoardIssueDetail
              issue={open.issue}
              state={open.state}
              environmentId={environmentId}
              projectId={props.projectId}
              threadRef={props.threadRef}
              connectedEnvironmentIds={connectedEnvironmentIds}
              onBack={onBack}
              onOpenUrl={onOpenUrl}
            />
          ) : null}
          {noteElement}
          <ReadyBoardView
            snapshot={snapshot}
            hidden={open !== null}
            view={view}
            filter={filter}
            onViewChange={setView}
            onFilterChange={setFilter}
            refreshing={refreshing}
            onRefresh={() => void onRefresh()}
            card={card}
          />
        </div>
      );
    }
  }
}

function failureTitle(reason: Extract<BoardSnapshot, { status: "failed" }>["failure"]["reason"]) {
  switch (reason) {
    case "unauthorized":
      return "Linear rejected your sign-in";
    case "sign-in-unavailable":
      return "Linear sign-in is not set up";
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
    case "issue-not-found":
      return "Issue not found";
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
  readonly hidden: boolean;
  readonly view: BoardView;
  readonly filter: BoardFilter;
  readonly onViewChange: (view: BoardView) => void;
  readonly onFilterChange: (filter: BoardFilter) => void;
  readonly refreshing: boolean;
  readonly onRefresh: () => void;
  readonly card: CardContext;
}) {
  const { board, failure } = props.snapshot;
  const columns = filterBoardColumns(board.columns, props.filter);
  const total = columns.reduce((count, column) => count + column.issues.length, 0);
  const loaded = board.columns.reduce((count, column) => count + column.issues.length, 0);
  const linearUrl = board.project?.url ?? null;
  return (
    <div className={cn("flex min-h-0 flex-1 flex-col", props.hidden && "hidden")}>
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
        <div className="min-w-0 flex-1 truncate text-sm font-medium">
          {board.team.name}
          {board.project && board.project.name !== board.team.name ? (
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
        <span className="min-w-0 flex-1 truncate whitespace-nowrap text-end text-xs text-muted-foreground">
          {props.refreshing ? (
            "Fetching…"
          ) : (
            <>
              Updated <RelativeTime timestamp={board.fetchedAt} />
            </>
          )}
        </span>
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
                  onClick={(event) => props.card.onOpenUrl(linearUrl, event)}
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
                <BoardCard issue={issue} stateType={column.state.type} card={props.card} />
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
  return `${issue.identifier} ${issue.title}, opens the issue details`;
}

function BoardCard(props: {
  readonly issue: BoardIssue;
  readonly stateType: string;
  readonly card: CardContext;
}) {
  const { issue, card } = props;
  const thread = boardCardThread(issue.threads, card.connectedEnvironmentIds);
  const time = boardIssueTime(issue, props.stateType);
  return (
    <div className="flex flex-col rounded-md border bg-background shadow-xs/5 hover:border-ring/40">
      <button
        type="button"
        aria-label={issueLabel(issue)}
        data-board-issue={issue.id}
        onClick={() => card.onOpenIssue(issue.id)}
        className="flex w-full flex-col gap-1.5 rounded-md p-2 text-left focus-visible:outline-2 focus-visible:outline-ring"
      >
        <div className="flex w-full items-center gap-1.5 text-xs text-muted-foreground">
          <PriorityGlyph priority={issue.priority} />
          <span className="font-mono">{issue.identifier}</span>
          <span className="flex-1" />
          <span className="text-2xs whitespace-nowrap">
            {time.verb} <RelativeTime timestamp={time.at} />
          </span>
          <Assignee assignee={issue.assignee} />
        </div>
        <div className="line-clamp-2 text-sm">{issue.title}</div>
        <IssueMeta issue={issue} environmentId={card.environmentId} />
      </button>
      {thread ? (
        <div className="flex items-center gap-1 border-t px-1.5 py-1">
          <BoardThreadChip
            link={thread}
            more={issue.threads.length - 1}
            connectedEnvironmentIds={card.connectedEnvironmentIds}
            onOpenLinear={(event) => card.onOpenUrl(issue.url, event)}
          />
        </div>
      ) : null}
    </div>
  );
}

function BoardRow(props: { readonly issue: BoardIssue; readonly card: CardContext }) {
  const { issue, card } = props;
  const thread = boardCardThread(issue.threads, card.connectedEnvironmentIds);
  return (
    <div className="relative flex w-full items-center gap-2 px-3 py-1.5 text-sm hover:bg-accent">
      <button
        type="button"
        aria-label={issueLabel(issue)}
        data-board-issue={issue.id}
        onClick={() => card.onOpenIssue(issue.id)}
        className="flex min-w-0 flex-1 items-center gap-2 text-left outline-none after:absolute after:inset-0 focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-ring"
      >
        <PriorityGlyph priority={issue.priority} />
        <span className="w-14 shrink-0 truncate font-mono text-xs text-muted-foreground">
          {issue.identifier}
        </span>
        <span className="min-w-0 flex-1 truncate">{issue.title}</span>
      </button>
      {thread ? (
        <BoardThreadChip
          link={thread}
          more={issue.threads.length - 1}
          compact
          connectedEnvironmentIds={card.connectedEnvironmentIds}
          onOpenLinear={(event) => card.onOpenUrl(issue.url, event)}
        />
      ) : null}
      <IssueMeta issue={issue} environmentId={card.environmentId} inline={thread ? 0 : 2} />
      <Assignee assignee={issue.assignee} />
    </div>
  );
}

function IssueMeta(props: {
  readonly issue: BoardIssue;
  readonly environmentId: EnvironmentId;
  /** In a list row: how many labels fit beside the title. */
  readonly inline?: number;
}) {
  const { issue } = props;
  const labels = props.inline === undefined ? issue.labels : issue.labels.slice(0, props.inline);
  if (labels.length === 0 && issue.pullRequests.length === 0) return null;
  return (
    <div
      className={cn(
        "flex min-w-0 flex-wrap items-center gap-1",
        props.inline !== undefined && "shrink-0 flex-nowrap",
      )}
    >
      {issue.pullRequests.map((pullRequest) => (
        <PullRequestBadge
          key={pullRequest.url}
          pullRequest={pullRequest}
          environmentId={props.environmentId}
        />
      ))}
      {labels.map((label) => (
        <PullRequestLabelChip key={label.id} label={{ name: label.name, color: label.color }} />
      ))}
    </div>
  );
}
