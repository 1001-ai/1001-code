import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  applyTeamProjectChanges,
  AuthSourceControlWriteScope,
  checkTeamCatalogProposal,
  type EnvironmentId,
  isTeamProjectOwner,
  matchingWriteChanges,
  describeTeamCatalogIssue,
  resolveTeamProjectGraph,
  type TeamCatalogLinkAccess,
  type TeamCatalogProjectChange,
  type TeamCatalogProposal,
  type TeamCatalogSnapshot,
  type TeamProjectLink,
} from "@t3tools/contracts";
import { ExternalLinkIcon, GitBranchIcon, PlusIcon, XIcon } from "lucide-react";
import { type ReactNode, useState } from "react";

import { useEnvironmentScope } from "../../state/session";
import { teamCatalogPropose } from "../../state/teamCatalog";
import { useAtomCommand } from "../../state/use-atom-command";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";

const NO_PARENT = "__none__";

interface Draft {
  readonly baseRevision: string;
  readonly key: string;
  readonly parent: string | null;
  readonly links: TeamCatalogProjectChange["links"];
}

function LinkStatus({
  link,
  names,
}: {
  link: TeamProjectLink | undefined;
  names: ReadonlyMap<string, string>;
}) {
  if (link === undefined) {
    return (
      <Badge variant="error" size="sm">
        Not in catalog
      </Badge>
    );
  }
  if (link.status === "pending") {
    return (
      <Badge variant="warning" size="sm">
        Pending {names.get(link.to) ?? link.to}
      </Badge>
    );
  }
  if (link.status === "no-access") {
    return (
      <Badge variant="outline" size="sm">
        No access
      </Badge>
    );
  }
  return (
    <Badge variant="success" size="sm">
      Active
    </Badge>
  );
}

function AccessSelect(props: {
  readonly value: TeamCatalogLinkAccess;
  readonly label: string;
  readonly onChange: (value: TeamCatalogLinkAccess) => void;
}) {
  return (
    <Select
      value={props.value}
      onValueChange={(value) => {
        if (value === "read" || value === "write") props.onChange(value);
      }}
    >
      <SelectTrigger size="xs" className="w-auto min-w-0" aria-label={props.label}>
        <SelectValue>{props.value === "write" ? "Write" : "Read"}</SelectValue>
      </SelectTrigger>
      <SelectPopup align="end" alignItemWithTrigger={false}>
        <SelectItem hideIndicator value="read">
          Read
        </SelectItem>
        <SelectItem hideIndicator value="write">
          Write
        </SelectItem>
      </SelectPopup>
    </Select>
  );
}

function Field(props: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <h3 className="text-xs font-medium text-muted-foreground">{props.label}</h3>
      {props.children}
    </div>
  );
}

/**
 * A team project's parent, owners and links. Owners edit them and propose the change to the
 * catalog repository as a pull request; everyone else reads them.
 */
export function TeamProjectLinksEditor(props: {
  readonly environmentId: EnvironmentId;
  readonly snapshot: TeamCatalogSnapshot;
  readonly projectKey: string;
}) {
  const { environmentId, snapshot, projectKey } = props;
  const canPush = useEnvironmentScope(environmentId, AuthSourceControlWriteScope);
  const propose = useAtomCommand(teamCatalogPropose, { reportFailure: false });
  const [draftState, setDraft] = useState<Draft | null>(null);
  const [skippedMirrors, setSkippedMirrors] = useState<ReadonlySet<string>>(new Set());
  const [newTarget, setNewTarget] = useState<string | null>(null);
  const [newAccess, setNewAccess] = useState<TeamCatalogLinkAccess>("read");
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [proposal, setProposal] = useState<TeamCatalogProposal | null>(null);

  const projects = snapshot.projects.map((entry) => entry.project);
  const project = projects.find((candidate) => candidate.key === projectKey);
  if (project === undefined || snapshot.revision === null) return null;
  const names = new Map(projects.map((candidate) => [candidate.key, candidate.name]));
  const reachableByKey = new Map(
    snapshot.projects.map((entry) => [entry.project.key, entry.reachable]),
  );
  const reachable = (key: string) => reachableByKey.get(key) ?? null;

  const login = snapshot.viewer.login;
  const isOwner = isTeamProjectOwner(project, login);
  const editable = isOwner && canPush;
  // A draft made against an older fetch is dropped; the fetched catalog wins.
  const draft =
    draftState !== null &&
    draftState.baseRevision === snapshot.revision &&
    draftState.key === project.key
      ? draftState
      : null;
  const change: TeamCatalogProjectChange = draft ?? {
    key: project.key,
    parent: project.parent ?? null,
    links: project.links ?? [],
  };
  const mirrors = matchingWriteChanges(projects, change);
  const includedMirrors = mirrors.filter((mirror) => !skippedMirrors.has(mirror.key));
  const changes = [change, ...includedMirrors];
  // Statuses follow this project's own edit; the other side's declaration counts once merged.
  const shownGraph = resolveTeamProjectGraph(
    applyTeamProjectChanges(projects, [change]),
    reachable,
  );
  const savedGraph = resolveTeamProjectGraph(projects, reachable);
  const outgoing = change.links.map((link) => ({
    to: link.project,
    access: link.access,
    resolved: shownGraph.links.find(
      (candidate) => candidate.from === project.key && candidate.to === link.project,
    ),
  }));
  const issues = savedGraph.issues.filter((issue) =>
    issue.kind === "parent-cycle"
      ? issue.projects.includes(project.key)
      : issue.project === project.key,
  );
  const incoming = savedGraph.links.filter((link) => link.to === project.key);
  const refusal = editable ? checkTeamCatalogProposal(projects, changes, login) : null;
  const unchanged = refusal === "Nothing changed.";
  const showProposal = editable && (draft !== null || (mirrors.length > 0 && proposal === null));

  const update = (next: Partial<Pick<Draft, "parent" | "links">>) => {
    setProposal(null);
    setFailure(null);
    setDraft({
      baseRevision: snapshot.revision!,
      key: project.key,
      parent: next.parent === undefined ? change.parent : next.parent,
      links: next.links ?? change.links,
    });
  };
  const linkable = projects.filter(
    (candidate) =>
      candidate.key !== project.key && !change.links.some((link) => link.project === candidate.key),
  );
  const parentChoices = projects.filter((candidate) => candidate.key !== project.key);

  const submit = async () => {
    setSaving(true);
    setFailure(null);
    const result = await propose({
      environmentId,
      input: { baseRevision: snapshot.revision!, changes },
    });
    setSaving(false);
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      setFailure(error instanceof Error ? error.message : "The change could not be proposed.");
      return;
    }
    setProposal(result.value);
    setDraft(null);
    setSkippedMirrors(new Set());
  };

  const ownerNote = isOwner
    ? canPush
      ? "You own this project. Changes are proposed to the catalog as a pull request."
      : "You own this project, but this connection cannot push to the catalog."
    : login === null
      ? (snapshot.viewer.problem ?? "Sign in to the GitHub CLI to edit projects you own.")
      : `Only its owners can change its links. You are signed in as ${login}.`;

  return (
    <div className="space-y-4 px-3 py-3 sm:px-4">
      <Field label="Owners">
        <div className="flex flex-wrap items-center gap-1.5">
          {project.owners.length === 0 ? (
            <span className="text-sm text-muted-foreground">None listed</span>
          ) : (
            project.owners.map((owner) => (
              <Badge key={owner} variant="outline">
                {owner}
              </Badge>
            ))
          )}
        </div>
        <p className="text-xs text-muted-foreground">{ownerNote}</p>
      </Field>

      <Field label="Parent">
        {editable ? (
          <Select
            value={change.parent ?? NO_PARENT}
            onValueChange={(value) => {
              if (typeof value !== "string") return;
              update({ parent: value === NO_PARENT ? null : value });
            }}
          >
            <SelectTrigger size="sm" className="w-full sm:w-64" aria-label="Parent project">
              <SelectValue>
                {change.parent === null ? "None" : (names.get(change.parent) ?? change.parent)}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup alignItemWithTrigger={false}>
              <SelectItem hideIndicator value={NO_PARENT}>
                None
              </SelectItem>
              {parentChoices.map((candidate) => (
                <SelectItem hideIndicator key={candidate.key} value={candidate.key}>
                  {candidate.name}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        ) : (
          <p className="text-sm">
            {change.parent === null ? "None" : (names.get(change.parent) ?? change.parent)}
          </p>
        )}
      </Field>

      <Field label="Links">
        <p className="text-xs text-muted-foreground">
          Projects this one's agents may read, or change through pull requests. A write link counts
          once both projects declare it.
        </p>
        {outgoing.length === 0 ? (
          <p className="text-sm text-muted-foreground">No links.</p>
        ) : (
          <ul className="divide-y divide-border/60 rounded-lg border border-border/60">
            {outgoing.map((link) => (
              <li key={link.to} className="flex min-h-10 items-center gap-2 px-2.5 py-1.5">
                <span className="min-w-0 flex-1 truncate text-sm">
                  {names.get(link.to) ?? link.to}
                </span>
                <LinkStatus link={link.resolved} names={names} />
                {editable ? (
                  <>
                    <div className="shrink-0">
                      <AccessSelect
                        value={link.access}
                        label={`Access to ${names.get(link.to) ?? link.to}`}
                        onChange={(access) =>
                          update({
                            links: change.links.map((candidate) =>
                              candidate.project === link.to ? { ...candidate, access } : candidate,
                            ),
                          })
                        }
                      />
                    </div>
                    <Button
                      type="button"
                      variant="ghost-destructive"
                      size="icon-xs"
                      aria-label={`Remove link to ${names.get(link.to) ?? link.to}`}
                      onClick={() =>
                        update({
                          links: change.links.filter((candidate) => candidate.project !== link.to),
                        })
                      }
                    >
                      <XIcon />
                    </Button>
                  </>
                ) : (
                  <span className="w-12 text-end text-xs text-muted-foreground">
                    {link.access === "write" ? "Write" : "Read"}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
        {editable && linkable.length > 0 ? (
          <div className="flex items-center gap-2">
            <div className="min-w-0 flex-1">
              <Select
                value={newTarget ?? ""}
                onValueChange={(value) => setNewTarget(typeof value === "string" ? value : null)}
              >
                <SelectTrigger size="xs" aria-label="Project to link">
                  <SelectValue>
                    {newTarget === null ? "Choose a project" : (names.get(newTarget) ?? newTarget)}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup alignItemWithTrigger={false}>
                  {linkable.map((candidate) => (
                    <SelectItem hideIndicator key={candidate.key} value={candidate.key}>
                      {candidate.name}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
            <div className="shrink-0">
              <AccessSelect
                value={newAccess}
                label="Access for the new link"
                onChange={setNewAccess}
              />
            </div>
            <Button
              type="button"
              variant="outline"
              size="xs"
              disabled={newTarget === null || !linkable.some((c) => c.key === newTarget)}
              onClick={() => {
                if (newTarget === null) return;
                update({ links: [...change.links, { project: newTarget, access: newAccess }] });
                setNewTarget(null);
              }}
            >
              <PlusIcon />
              Add link
            </Button>
          </div>
        ) : null}
      </Field>

      {issues.length > 0 ? (
        <ul className="space-y-1 text-xs text-warning-foreground">
          {issues.map((issue) => (
            <li key={describeTeamCatalogIssue(issue)}>{describeTeamCatalogIssue(issue)}</li>
          ))}
        </ul>
      ) : null}

      {incoming.length > 0 ? (
        <Field label="Linked from">
          <ul className="space-y-1">
            {incoming.map((link) => (
              <li key={link.from} className="flex items-center gap-2 text-sm">
                <span className="min-w-0 flex-1 truncate">{names.get(link.from) ?? link.from}</span>
                <span className="text-xs text-muted-foreground">
                  {link.access === "write" ? "writes" : "reads"}
                </span>
                {link.access === "write" && link.status === "pending" ? (
                  <Badge variant="warning" size="sm">
                    Waiting for this project
                  </Badge>
                ) : null}
              </li>
            ))}
          </ul>
        </Field>
      ) : null}

      {showProposal ? (
        <div className="space-y-3 rounded-lg border border-border/60 bg-muted/30 p-3">
          {mirrors.length > 0 ? (
            <div className="space-y-2">
              {mirrors.map((mirror) => (
                <label key={mirror.key} className="flex items-start gap-2 text-sm">
                  <Checkbox
                    checked={!skippedMirrors.has(mirror.key)}
                    onCheckedChange={(checked) => {
                      const next = new Set(skippedMirrors);
                      if (checked) next.delete(mirror.key);
                      else next.add(mirror.key);
                      setSkippedMirrors(next);
                    }}
                  />
                  <span>
                    Also propose {names.get(mirror.key) ?? mirror.key}'s matching write link, in the
                    same pull request. Its owners still approve it.
                  </span>
                </label>
              ))}
            </div>
          ) : null}
          {refusal !== null && !unchanged ? (
            <p className="text-sm text-destructive-foreground">{refusal}</p>
          ) : null}
          {failure !== null ? (
            <p className="text-sm text-destructive-foreground">{failure}</p>
          ) : null}
          <div className="flex flex-wrap justify-end gap-2">
            {draft !== null ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={saving}
                onClick={() => {
                  setDraft(null);
                  setFailure(null);
                  setSkippedMirrors(new Set());
                }}
              >
                Discard
              </Button>
            ) : null}
            <Button
              type="button"
              size="sm"
              disabled={saving || refusal !== null}
              onClick={() => void submit()}
            >
              <GitBranchIcon />
              {saving ? "Proposing…" : "Propose change"}
            </Button>
          </div>
        </div>
      ) : null}

      {proposal !== null ? (
        <Alert variant="success">
          <GitBranchIcon />
          <AlertTitle>
            {proposal.pullRequestUrl === null ? "Branch pushed" : "Pull request opened"}
          </AlertTitle>
          <AlertDescription>
            <p>
              <code className="text-xs break-all">{proposal.branch}</code> on{" "}
              <code className="text-xs break-all">{proposal.remote}</code> changes{" "}
              {proposal.files.join(" and ")}. The catalog changes once that repository merges it.
            </p>
            {proposal.pullRequestProblem !== null ? (
              <p>No pull request was opened: {proposal.pullRequestProblem}</p>
            ) : null}
            {proposal.pullRequestUrl !== null ? (
              <Button
                variant="outline"
                size="xs"
                render={<a href={proposal.pullRequestUrl} target="_blank" rel="noreferrer" />}
              >
                <ExternalLinkIcon />
                Open pull request
              </Button>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}
