import { LegendList } from "@legendapp/list/react";
import {
  type AgentsBoardAgent,
  type AgentsBoardMessage,
  type AgentsBoardSnapshot,
  type EnvironmentId,
  type ProjectId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { BotMessageSquareIcon, GitBranchIcon, Settings2Icon } from "lucide-react";
import { useState } from "react";

import { RelativeTime } from "~/components/RelativeTime";
import { agentsBoardRefresh, useAgentsBoard } from "~/state/agentsBoard";
import { useAtomCommand } from "~/state/use-atom-command";
import { ExpandedImageDialog } from "../chat/ExpandedImageDialog";
import type { ExpandedImagePreview } from "../chat/ExpandedImagePreview";
import { Alert, AlertDescription } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { RefreshIcon } from "../ui/refresh-icon";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  agentsBoardCounts,
  agentsBoardRecipient,
  agentsBoardStatusLabel,
  agentsBoardStatusTone,
  agentsBoardTime,
} from "./agentsBoard.logic";
import { AgentsBoardAgentCommand } from "./AgentsBoardAgentCommand";
import { AgentsBoardThumbnail } from "./AgentsBoardThumbnail";

type ReadyBoard = Extract<AgentsBoardSnapshot, { status: "ready" }>;

interface RowContext {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly agents: ReadonlyMap<string, AgentsBoardAgent>;
  readonly onOpenImage: (preview: ExpandedImagePreview) => void;
}

const MAINTAIN_SCROLL_AT_END = {
  animated: false,
  on: { dataChange: true, itemLayout: true, layout: true },
} as const;

/**
 * The messages the agents working in a team project write to the project's agents branch, oldest
 * at the top. Read-only: the text is other agents' words, shown as plain text and never followed.
 */
export default function AgentsBoardPanel(props: {
  readonly threadRef: ScopedThreadRef;
  readonly projectId: ProjectId | null;
}) {
  const environmentId = props.threadRef.environmentId;
  const snapshot = useAgentsBoard(environmentId, props.projectId);
  const refresh = useAtomCommand(agentsBoardRefresh);
  const navigate = useNavigate();
  const [asked, setAsked] = useState(false);
  const [preview, setPreview] = useState<ExpandedImagePreview | null>(null);

  if (props.projectId === null) {
    return (
      <BoardMessage title="No project" description="Open a project to see its agents board." />
    );
  }
  const projectId = props.projectId;
  if (snapshot === null) return <Loading label="Loading the agents board" />;

  const onRefresh = async () => {
    setAsked(true);
    await refresh({ environmentId, input: { projectId } });
    setAsked(false);
  };
  const refreshing = asked || (snapshot.status !== "unavailable" && snapshot.refreshing);
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

  switch (snapshot.status) {
    case "unavailable":
      return (
        <BoardMessage
          title={snapshot.reason === "no-catalog" ? "No team catalog" : "Not a team project"}
          description={
            snapshot.reason === "no-catalog"
              ? "An agents board belongs to a team project. Set up the team project catalog first."
              : "No project in the team catalog lists this project's repository, so it has no agents board."
          }
        >
          {snapshot.reason === "not-in-catalog" ? refreshButton : null}
          <Button
            size="sm"
            variant="outline"
            onClick={() => void navigate({ to: "/settings/threads", hash: "team-catalog" })}
          >
            <Settings2Icon />
            Team projects settings
          </Button>
        </BoardMessage>
      );
    case "loading":
      return <Loading label={`Fetching ${snapshot.branch}`} />;
    case "missing-branch":
      return (
        <BoardMessage
          title="No agent messages yet"
          description={
            <>
              The repository of {snapshot.project.name} has no branch named{" "}
              <code className="font-mono text-xs">{snapshot.branch}</code> yet. Agents write their
              messages there. To have an agent start, give it this line:
            </>
          }
        >
          <div className="w-full max-w-md">
            <AgentsBoardAgentCommand branch={snapshot.branch} />
          </div>
          {refreshButton}
        </BoardMessage>
      );
    case "failed":
      return (
        <BoardMessage
          title="Could not fetch the agents branch"
          description={snapshot.failure}
          alert
        >
          {refreshButton}
        </BoardMessage>
      );
    case "ready":
      return (
        <>
          <ReadyBoardView
            snapshot={snapshot}
            environmentId={environmentId}
            projectId={projectId}
            refreshing={refreshing}
            onRefresh={() => void onRefresh()}
            onOpenImage={setPreview}
          />
          {preview !== null ? (
            <ExpandedImageDialog preview={preview} onClose={() => setPreview(null)} />
          ) : null}
        </>
      );
  }
}

function Loading(props: { readonly label: string }) {
  return (
    <div
      role="status"
      aria-label={props.label}
      className="flex min-h-0 flex-1 items-center justify-center"
    >
      <Spinner />
    </div>
  );
}

function BoardMessage(props: {
  readonly title: string;
  readonly description: React.ReactNode;
  readonly alert?: boolean;
  readonly children?: React.ReactNode;
}) {
  return (
    <Empty
      role={props.alert ? "alert" : undefined}
      className="scrollbar-gutter-both min-h-0 flex-1 justify-center-safe overflow-y-auto [&>*]:shrink-0"
    >
      <EmptyMedia variant="icon">
        <BotMessageSquareIcon />
      </EmptyMedia>
      <EmptyHeader>
        <EmptyTitle>{props.title}</EmptyTitle>
        <EmptyDescription>{props.description}</EmptyDescription>
      </EmptyHeader>
      {props.children ? (
        <div className="flex w-full flex-wrap justify-center gap-2">{props.children}</div>
      ) : null}
    </Empty>
  );
}

function ReadyBoardView(props: {
  readonly snapshot: ReadyBoard;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly refreshing: boolean;
  readonly onRefresh: () => void;
  readonly onOpenImage: (preview: ExpandedImagePreview) => void;
}) {
  const { board, branch, project, failure, fetchedAt } = props.snapshot;
  const context: RowContext = {
    environmentId: props.environmentId,
    projectId: props.projectId,
    agents: new Map(board.agents.map((agent) => [agent.id, agent])),
    onOpenImage: props.onOpenImage,
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b px-3 py-2">
        <div className="min-w-0 flex-1 text-sm">
          <span className="font-medium">{project.name}</span>
          <span className="text-muted-foreground">
            {" · "}
            <span className="font-mono text-xs">{branch}</span>
            {" · "}
            {agentsBoardCounts(board)}
          </span>
        </div>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label="Refresh agents board"
                disabled={props.refreshing}
                aria-busy={props.refreshing}
                onClick={props.onRefresh}
              >
                <RefreshIcon refreshing={props.refreshing} />
              </Button>
            }
          />
          <TooltipPopup>
            Refresh. Fetched <RelativeTime timestamp={fetchedAt} />
          </TooltipPopup>
        </Tooltip>
      </div>
      {failure !== null ? (
        <div className="px-3 pt-2">
          <Alert variant="warning">
            <AlertDescription>
              Showing the messages fetched at {agentsBoardTime(fetchedAt)}. The latest fetch failed:{" "}
              {failure}
            </AlertDescription>
          </Alert>
        </div>
      ) : null}
      {board.truncated ? (
        <p className="px-3 pt-2 text-xs text-muted-foreground">
          The branch holds more than the board shows. The newest messages are below.
        </p>
      ) : null}
      {board.messages.length === 0 ? (
        <BoardMessage
          title="No messages yet"
          description={
            board.agents.length === 0
              ? "The branch exists, and no agent has written to it yet."
              : "The agents on this branch have not written a message yet."
          }
        />
      ) : (
        <LegendList<AgentsBoardMessage>
          data={board.messages}
          extraData={context}
          keyExtractor={(message) => message.id}
          renderItem={({ item }) => <MessageRow message={item} context={context} />}
          estimatedItemSize={104}
          initialScrollAtEnd
          maintainScrollAtEnd={MAINTAIN_SCROLL_AT_END}
          aria-label="Agent messages"
          className="scrollbar-gutter-both h-full min-h-0 flex-1 overflow-x-hidden overscroll-y-contain"
        />
      )}
    </div>
  );
}

function MessageTime(props: { readonly at: string }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <time
            dateTime={props.at}
            className="shrink-0 text-xs text-muted-foreground tabular-nums"
          />
        }
      >
        <RelativeTime timestamp={props.at} />
      </TooltipTrigger>
      <TooltipPopup>{agentsBoardTime(props.at)}</TooltipPopup>
    </Tooltip>
  );
}

function MessageRow(props: { readonly message: AgentsBoardMessage; readonly context: RowContext }) {
  const { message, context } = props;
  if (message._tag === "person") {
    return (
      <div className="flex justify-end px-3 py-1.5">
        <div className="max-w-[85%] min-w-0 rounded-lg bg-info/8 px-3 py-2 dark:bg-info/16">
          <div className="flex items-baseline gap-2">
            <span className="min-w-0 truncate text-sm font-medium">
              {message.from ?? "A person"}
            </span>
            <span className="min-w-0 truncate text-xs text-muted-foreground">
              to {agentsBoardRecipient(message.to)}
            </span>
            <span className="flex-1" />
            <MessageTime at={message.at} />
          </div>
          <p className="mt-1 text-sm wrap-anywhere whitespace-pre-wrap">{message.text}</p>
          {message.via !== null ? (
            <p className="mt-1 text-xs text-muted-foreground">via {message.via}</p>
          ) : null}
        </div>
      </div>
    );
  }
  const agent = context.agents.get(message.agentId);
  return (
    <div className="border-b border-border/60 px-3 py-2.5">
      <div className="flex items-center gap-2">
        <span className="min-w-0 shrink-0 truncate font-mono text-xs font-medium">
          {message.agentId}
        </span>
        {agent?.tool ? (
          <span className="min-w-0 truncate text-xs text-muted-foreground">{agent.tool}</span>
        ) : null}
        <span className="flex-1" />
        {message.status !== null ? (
          <Badge size="sm" variant={agentsBoardStatusTone(message.status)}>
            {agentsBoardStatusLabel(message.status)}
          </Badge>
        ) : null}
        <MessageTime at={message.at} />
      </div>
      {message.text !== "" ? (
        <p className="mt-1 text-sm wrap-anywhere whitespace-pre-wrap">{message.text}</p>
      ) : null}
      {message.needs !== null ? (
        <p className="mt-1.5 rounded-md bg-warning/8 px-2 py-1 text-sm wrap-anywhere text-warning-foreground dark:bg-warning/16">
          <span className="font-medium">Needs:</span> {message.needs}
        </p>
      ) : null}
      {message.next !== null ? (
        <p className="mt-1 text-xs wrap-anywhere text-muted-foreground">
          <span className="font-medium">Next:</span> {message.next}
        </p>
      ) : null}
      {message.branch !== null || message.pr !== null ? (
        <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
          {message.branch !== null ? (
            <span className="inline-flex min-w-0 items-center gap-1">
              <GitBranchIcon className="size-3 shrink-0" aria-label="Branch" />
              <span className="font-mono wrap-anywhere">{message.branch}</span>
            </span>
          ) : null}
          {message.pr !== null ? (
            <span className="min-w-0 wrap-anywhere">
              <span className="font-medium">Pull request:</span> {message.pr}
            </span>
          ) : null}
        </p>
      ) : null}
      {message.media.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-2">
          {message.media.map((path) => (
            <AgentsBoardThumbnail
              key={path}
              environmentId={context.environmentId}
              projectId={context.projectId}
              path={path}
              onOpen={context.onOpenImage}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
