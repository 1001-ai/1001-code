import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  AuthSourceControlWriteScope,
  type ProjectId,
  type ScopedThreadRef,
  type TeamCatalogProposal,
  MEMORY_MAX_BYTES,
  type MemoryDocument,
  type MemoryProposal,
  type MemoryScope,
  type MemoryView,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ScrollTextIcon, Settings2Icon } from "lucide-react";
import { useState } from "react";

import { useEnvironmentScope } from "~/state/session";
import { teamCatalogRefresh } from "~/state/teamCatalog";
import { memoryPropose, useMemory } from "~/state/memory";
import { useAtomCommand } from "~/state/use-atom-command";
import { RelativeTime } from "../RelativeTime";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { RefreshIcon } from "../ui/refresh-icon";
import { Spinner } from "../ui/spinner";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { MemoryDocumentSection, type MemoryDraft } from "./MemoryDocumentSection";
import { MemoryDecisionButtons, MemoryReplaces, useMemoryDecision } from "./MemoryProposalCard";
import { changeCount, type MemoryEdits, memoryFileText, NO_EDITS } from "./memoryRows.logic";
import { VoiceAgentMemories } from "./VoiceAgentMemories";

const TABS = ["team", "project", "personal", "voice", "proposals"] as const;
type Tab = (typeof TABS)[number];

const TAB_LABEL: Record<Tab, string> = {
  team: "Team",
  project: "Project",
  personal: "Personal",
  voice: "Voice agent",
  proposals: "Proposals",
};

const TAB_SCOPES: Record<Exclude<Tab, "voice" | "proposals">, ReadonlyArray<MemoryScope>> = {
  team: ["team"],
  project: ["project"],
  personal: ["personal-project", "personal"],
};

const isTab = (value: unknown): value is Tab => TABS.some((tab) => tab === value);

/** Revision, size and an approximate token count, at about four bytes a token. */
function blockStatus(view: MemoryView): string {
  const revision =
    view.revision === null ? "not fetched yet" : `revision ${view.revision.slice(0, 7)}`;
  if (view.block === null) return `Nothing is sent yet · ${revision}`;
  const bytes = new TextEncoder().encode(view.block).length;
  const size = `About ${Math.ceil(bytes / 4).toLocaleString()} tokens (${(bytes / 1024).toFixed(1)} of ${MEMORY_MAX_BYTES / 1024} KB)`;
  return `${size} · ${revision}${view.truncated ? " · over the limit, so the end is left out" : ""}`;
}

/** The project's memory in the right panel: one row per line with its author, changed as a pull request. */
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
        description="Memory lives in the team catalog repository, under memory/. Set the catalog in Settings."
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
  const [tab, setTab] = useState<Tab>("team");
  const [drafts, setDrafts] = useState<Partial<Record<MemoryScope, MemoryDraft>>>({});
  const [saving, setSaving] = useState<MemoryScope | null>(null);
  const [failures, setFailures] = useState<Partial<Record<MemoryScope, string>>>({});
  const [pullRequests, setPullRequests] = useState<
    Partial<Record<MemoryScope, TeamCatalogProposal>>
  >({});

  const waiting = view.proposals.filter((proposal) => proposal.decision === null);
  const documents =
    tab === "proposals" || tab === "voice"
      ? []
      : TAB_SCOPES[tab].flatMap((scope) => {
          const document = view.documents.find((candidate) => candidate.scope === scope);
          return document === undefined ? [] : [document];
        });
  const status = blockStatus(view);
  const editBlocked = !canPush
    ? "This connection cannot push to the team repository."
    : view.viewer.login === null
      ? (view.viewer.problem ?? "Sign in to the GitHub CLI with gh auth login to propose changes.")
      : view.revision === null
        ? "The team repository has not been fetched yet."
        : null;

  const setFailure = (scope: MemoryScope, failure: string | undefined) =>
    setFailures((current) => ({ ...current, [scope]: failure }));
  const dropDraft = (scope: MemoryScope) => {
    setDrafts((current) => ({ ...current, [scope]: undefined }));
    setFailure(scope, undefined);
  };
  // Opening an editor pins the lines and revision, so a fetch never moves the rows being changed.
  const pinDraft = (document: MemoryDocument) => {
    if (drafts[document.scope] !== undefined || view.revision === null) return;
    setDrafts({
      ...drafts,
      [document.scope]: { baseRevision: view.revision, lines: document.lines, edits: NO_EDITS },
    });
  };
  const changeDraft = (document: MemoryDocument, edits: MemoryEdits) => {
    if (changeCount(edits) === 0) return dropDraft(document.scope);
    const current = drafts[document.scope];
    if (current === undefined && view.revision === null) return;
    setDrafts({
      ...drafts,
      [document.scope]: current
        ? { ...current, edits }
        : { baseRevision: view.revision!, lines: document.lines, edits },
    });
  };

  const submit = async (scope: MemoryScope) => {
    const draft = drafts[scope];
    if (draft === undefined) return;
    setSaving(scope);
    setFailure(scope, undefined);
    const result = await propose({
      environmentId,
      input: {
        projectId: props.projectId,
        scope,
        baseRevision: draft.baseRevision,
        text: memoryFileText(draft.lines, draft.edits),
      },
    });
    setSaving(null);
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      setFailure(
        scope,
        error instanceof Error ? error.message : "The change could not be proposed.",
      );
      return;
    }
    setPullRequests({ ...pullRequests, [scope]: result.value });
    dropDraft(scope);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
        <ToggleGroup
          aria-label="Memory scope"
          value={[tab]}
          onValueChange={(next) => {
            const value = next[0];
            if (isTab(value)) setTab(value);
          }}
        >
          {TABS.map((candidate) => (
            <Toggle key={candidate} value={candidate}>
              {TAB_LABEL[candidate]}
              {candidate === "proposals" && waiting.length > 0 ? (
                <Badge size="sm">{waiting.length}</Badge>
              ) : null}
            </Toggle>
          ))}
        </ToggleGroup>
        <span className="min-w-0 flex-1 truncate whitespace-nowrap text-end text-xs text-muted-foreground">
          {view.refreshing ? (
            "Fetching…"
          ) : view.fetchedAt === null ? (
            "Not fetched yet"
          ) : (
            <>
              Updated <RelativeTime timestamp={view.fetchedAt} />
            </>
          )}
        </span>
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
        {tab === "proposals" ? (
          <MemoryProposals
            threadRef={props.threadRef}
            projectId={props.projectId}
            proposals={waiting}
          />
        ) : (
          <div className="space-y-6 px-4 py-3">
            {view.error !== null ? (
              <p className="text-xs text-warning-foreground">
                The last fetch failed, so this is the last good copy: {view.error}
              </p>
            ) : null}
            {documents.map((document) => (
              <MemoryDocumentSection
                key={document.scope}
                threadRef={props.threadRef}
                source={view.source}
                document={document}
                draft={drafts[document.scope] ?? null}
                editBlocked={editBlocked}
                saving={saving === document.scope}
                failure={failures[document.scope] ?? null}
                pullRequest={pullRequests[document.scope]}
                onEditsChange={(edits) => changeDraft(document, edits)}
                onBeginEdit={() => pinDraft(document)}
                onDiscard={() => dropDraft(document.scope)}
                onPropose={() => void submit(document.scope)}
              />
            ))}
            {tab === "voice" ? <VoiceAgentMemories document={view.voiceAgent} /> : null}
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

/** Proposals nobody has answered, so one buried in a long thread is not lost. */
function MemoryProposals(props: {
  readonly threadRef: ScopedThreadRef;
  readonly projectId: ProjectId;
  readonly proposals: ReadonlyArray<MemoryProposal>;
}) {
  const environmentId = props.threadRef.environmentId;
  const decision = useMemoryDecision(environmentId, props.projectId);
  const navigate = useNavigate();
  if (props.proposals.length === 0) {
    return (
      <p className="px-4 py-3 text-sm text-muted-foreground">
        No proposals waiting. Agents propose memories as they work, and you answer them in the chat
        or here.
      </p>
    );
  }
  return (
    <div className="space-y-3 px-4 py-3">
      <p className="text-xs text-muted-foreground">
        Agents in this project's threads proposed these. Nothing changes until you accept.
      </p>
      {decision.error !== null ? (
        <p role="alert" className="text-xs text-destructive">
          {decision.error}
        </p>
      ) : null}
      {props.proposals.map((proposal) => (
        <div
          key={proposal.id}
          className="flex min-w-0 flex-col gap-1.5 rounded-lg border border-border/70 bg-card px-3 py-2.5"
        >
          <p className="text-sm [overflow-wrap:anywhere]">{proposal.text}</p>
          {proposal.category === undefined ? null : (
            <p className="text-xs text-muted-foreground">For the voice agent</p>
          )}
          <MemoryReplaces replaces={proposal.replaces ?? null} />
          {proposal.reason !== "" ? (
            <p className="text-xs text-muted-foreground">{proposal.reason}</p>
          ) : null}
          <p className="text-xs text-muted-foreground">
            From{" "}
            <button
              type="button"
              className="underline underline-offset-2 hover:text-foreground"
              onClick={() =>
                void navigate({
                  to: "/$environmentId/$threadId",
                  params: { environmentId, threadId: proposal.threadId },
                })
              }
            >
              {proposal.threadTitle || "a thread"}
            </button>
          </p>
          <div className="flex flex-wrap gap-2">
            <MemoryDecisionButtons
              busy={decision.busy}
              canDecide={decision.canDecide}
              personalOnly={proposal.category !== undefined}
              onChoose={(choice) => void decision.submit(proposal, choice, proposal.text)}
            />
          </div>
        </div>
      ))}
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
