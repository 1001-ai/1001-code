import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  AuthSourceControlWriteScope,
  type ProjectId,
  type ScopedThreadRef,
  type TeamCatalogProposal,
  MEMORY_MAX_BYTES,
  type MemoryDocument,
  type MemoryScope,
  type MemoryView,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  ExternalLinkIcon,
  GitBranchIcon,
  PencilIcon,
  ScrollTextIcon,
  Settings2Icon,
} from "lucide-react";
import { useState } from "react";

import { useOpenLink } from "~/browser/useOpenLink";
import { useEnvironmentScope } from "~/state/session";
import { teamCatalogRefresh } from "~/state/teamCatalog";
import { memoryPropose, useMemory } from "~/state/memory";
import { useAtomCommand } from "~/state/use-atom-command";
import ChatMarkdown from "../ChatMarkdown";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { RefreshIcon } from "../ui/refresh-icon";
import { Spinner } from "../ui/spinner";
import { Textarea } from "../ui/textarea";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const SCOPE_LABEL: Record<MemoryScope, string> = {
  team: "Team",
  project: "Project",
  personal: "Personal",
};

/** Revision, size and an approximate token count, at about four bytes a token. */
function blockStatus(view: MemoryView): string {
  const revision =
    view.revision === null ? "not fetched yet" : `revision ${view.revision.slice(0, 7)}`;
  if (view.block === null) return `Nothing is sent yet · ${revision}`;
  const bytes = new TextEncoder().encode(view.block).length;
  const size = `About ${Math.ceil(bytes / 4).toLocaleString()} tokens (${(bytes / 1024).toFixed(1)} of ${MEMORY_MAX_BYTES / 1024} KB)`;
  return `${size} · ${revision}${view.truncated ? " · over the limit, so the end is left out" : ""}`;
}

interface Draft {
  readonly scope: MemoryScope;
  readonly baseRevision: string;
  readonly text: string;
}

/** The project's memory in the right panel: markdown read in place, edited as a pull request. */
export default function MemoryPanel(props: {
  readonly threadRef: ScopedThreadRef;
  readonly projectId: ProjectId | null;
}) {
  const environmentId = props.threadRef.environmentId;
  const view = useMemory(environmentId, props.projectId);
  const refresh = useAtomCommand(teamCatalogRefresh);
  const navigate = useNavigate();

  if (props.projectId === null) {
    return (
      <MemoryMessage
        title="No project"
        description="Open a project to see the memory its agents get."
      />
    );
  }
  if (view === null) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center">
        <Spinner />
      </div>
    );
  }
  if (view.source === null) {
    return (
      <MemoryMessage
        title="No team catalog"
        description="Memory live in the team catalog repository, under memory/. Set the catalog in Settings."
      >
        <Button
          size="sm"
          variant="outline"
          onClick={() => void navigate({ to: "/settings/threads", hash: "team-catalog" })}
        >
          <Settings2Icon />
          Team projects settings
        </Button>
      </MemoryMessage>
    );
  }
  return (
    <MemoryDocuments
      threadRef={props.threadRef}
      projectId={props.projectId}
      view={view}
      onRefresh={() => void refresh({ environmentId, input: { force: true } })}
    />
  );
}

function MemoryDocuments(props: {
  readonly threadRef: ScopedThreadRef;
  readonly projectId: ProjectId;
  readonly view: MemoryView;
  readonly onRefresh: () => void;
}) {
  const { view } = props;
  const environmentId = props.threadRef.environmentId;
  const canPush = useEnvironmentScope(environmentId, AuthSourceControlWriteScope);
  const propose = useAtomCommand(memoryPropose, { reportFailure: false });
  const openLink = useOpenLink(props.threadRef);
  const [scope, setScope] = useState<MemoryScope>("team");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [proposals, setProposals] = useState<Partial<Record<MemoryScope, TeamCatalogProposal>>>({});

  const document = view.documents.find((candidate) => candidate.scope === scope);
  const editing = draft !== null && draft.scope === scope ? draft : null;
  const status = blockStatus(view);
  const proposal = proposals[scope];
  const editBlocked = !canPush
    ? "This connection cannot push to the team repository."
    : view.viewer.login === null
      ? (view.viewer.problem ?? "Sign in to the GitHub CLI with gh auth login to propose changes.")
      : null;

  const submit = async () => {
    if (editing === null) return;
    setSaving(true);
    setFailure(null);
    const result = await propose({
      environmentId,
      input: {
        projectId: props.projectId,
        scope: editing.scope,
        baseRevision: editing.baseRevision,
        text: editing.text,
      },
    });
    setSaving(false);
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      setFailure(error instanceof Error ? error.message : "The change could not be proposed.");
      return;
    }
    setProposals({ ...proposals, [editing.scope]: result.value });
    setDraft(null);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
        <ToggleGroup
          aria-label="Memory scope"
          value={[scope]}
          onValueChange={(next) => {
            const value = next[0];
            if (value === "team" || value === "project" || value === "personal") {
              setScope(value);
              setFailure(null);
            }
          }}
        >
          {view.documents.map((candidate) => (
            <Toggle key={candidate.scope} value={candidate.scope}>
              {SCOPE_LABEL[candidate.scope]}
            </Toggle>
          ))}
        </ToggleGroup>
        <div className="min-w-0 flex-1" />
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label="Refresh memory"
                disabled={view.refreshing}
                aria-busy={view.refreshing}
                onClick={props.onRefresh}
              >
                <RefreshIcon refreshing={view.refreshing} />
              </Button>
            }
          />
          <TooltipPopup>Fetch the team repository</TooltipPopup>
        </Tooltip>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {document === undefined ? null : (
          <div className="space-y-3 px-4 py-3">
            <DocumentHeading
              document={document}
              editing={editing !== null}
              editBlocked={editBlocked}
              onEdit={() => {
                if (view.revision === null) return;
                setFailure(null);
                setDraft({ scope, baseRevision: view.revision, text: document.text });
              }}
            />
            {view.error !== null ? (
              <p className="text-xs text-warning-foreground">
                The last fetch failed, so this is the last good copy: {view.error}
              </p>
            ) : null}
            {document.file === null ? (
              <p className="text-sm text-muted-foreground">{document.unavailable}</p>
            ) : editing !== null ? (
              <div className="space-y-2">
                <Textarea
                  aria-label={`${SCOPE_LABEL[scope]} memory`}
                  rows={16}
                  value={editing.text}
                  maxLength={MEMORY_MAX_BYTES}
                  onChange={(event) => setDraft({ ...editing, text: event.target.value })}
                  placeholder={"- One memory per line, in plain words.\n- Another one."}
                />
                <p className="text-xs text-muted-foreground">
                  Saving opens a pull request on the team repository. The change is pending until it
                  is merged; the repository's review rules decide who approves it.
                </p>
                {failure !== null ? (
                  <p className="text-sm text-destructive-foreground">{failure}</p>
                ) : null}
                <div className="flex flex-wrap justify-end gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={saving}
                    onClick={() => {
                      setDraft(null);
                      setFailure(null);
                    }}
                  >
                    Cancel
                  </Button>
                  <Button
                    size="sm"
                    disabled={saving || editing.text === document.text}
                    onClick={() => void submit()}
                  >
                    <GitBranchIcon />
                    {saving ? "Proposing…" : "Propose change"}
                  </Button>
                </div>
              </div>
            ) : document.text.trim() === "" ? (
              <p className="text-sm text-muted-foreground">
                No {SCOPE_LABEL[scope].toLowerCase()} memory yet.
              </p>
            ) : (
              <ChatMarkdown
                text={document.text}
                cwd={undefined}
                environmentId={environmentId}
                threadRef={props.threadRef}
              />
            )}
            {proposal !== undefined && editing === null ? (
              <Alert variant="success">
                <GitBranchIcon />
                <AlertTitle>
                  {proposal.pullRequestUrl === null
                    ? "Branch pushed, pending until merged"
                    : "Pull request opened, pending until merged"}
                </AlertTitle>
                <AlertDescription>
                  <p>
                    <code className="text-xs break-all">{proposal.branch}</code> changes{" "}
                    {proposal.files.join(" and ")}. Agents get it once it is merged and fetched.
                  </p>
                  {proposal.pullRequestProblem !== null ? (
                    <p>No pull request was opened: {proposal.pullRequestProblem}</p>
                  ) : null}
                  {proposal.pullRequestUrl !== null ? (
                    <Button
                      variant="outline"
                      size="xs"
                      onClick={(event) =>
                        void openLink(proposal.pullRequestUrl!, { event }).catch(() => undefined)
                      }
                    >
                      <ExternalLinkIcon />
                      Open pull request
                    </Button>
                  ) : null}
                </AlertDescription>
              </Alert>
            ) : null}
          </div>
        )}
      </div>

      <div className="space-y-1 border-t px-3 py-2 text-xs text-muted-foreground">
        <p>Agents pick up changes on their next turn.</p>
        <p>{status}</p>
        {view.block !== null ? (
          <details>
            <summary className="cursor-pointer select-none">What agents get</summary>
            <pre className="mt-1 max-h-48 overflow-auto rounded-md bg-muted/40 p-2 font-mono text-2xs whitespace-pre-wrap">
              {view.block}
            </pre>
          </details>
        ) : null}
      </div>
    </div>
  );
}

function DocumentHeading(props: {
  readonly document: MemoryDocument;
  readonly editing: boolean;
  readonly editBlocked: string | null;
  readonly onEdit: () => void;
}) {
  const { document } = props;
  const title =
    document.scope === "team" || document.label === null
      ? SCOPE_LABEL[document.scope]
      : `${SCOPE_LABEL[document.scope]} · ${document.label}`;
  return (
    <div className="flex items-start gap-2">
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{title}</div>
        {document.file !== null && (
          <div className="truncate text-xs text-muted-foreground">
            <code>{document.file}</code>
          </div>
        )}
      </div>
      {document.file !== null && !props.editing ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <span>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={props.editBlocked !== null}
                  onClick={props.onEdit}
                >
                  <PencilIcon />
                  Edit
                </Button>
              </span>
            }
          />
          <TooltipPopup>{props.editBlocked ?? "Propose a change as a pull request"}</TooltipPopup>
        </Tooltip>
      ) : null}
    </div>
  );
}

function MemoryMessage(props: {
  readonly title: string;
  readonly description: string;
  readonly children?: React.ReactNode;
}) {
  return (
    <Empty className="scrollbar-gutter-both min-h-0 flex-1 justify-center-safe overflow-y-auto [&>*]:shrink-0">
      <EmptyMedia variant="icon">
        <ScrollTextIcon />
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
