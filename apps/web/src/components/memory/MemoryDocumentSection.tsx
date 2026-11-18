import type {
  MemoryDocument,
  MemoryLine,
  MemoryScope,
  ScopedThreadRef,
  TeamCatalogProposal,
} from "@t3tools/contracts";
import { ExternalLinkIcon, GitBranchIcon, PlusIcon } from "lucide-react";
import { useState } from "react";

import { useOpenLink } from "~/browser/useOpenLink";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { MemoryAttribution, MemoryRowEditor, MemoryRowView } from "./MemoryRow";
import {
  changeCount,
  editRow,
  type MemoryEdits,
  memoryRows,
  NO_EDITS,
  pullRequestUrl,
  removeRow,
  restoreRow,
  setAdded,
} from "./memoryRows.logic";

const SCOPE_LABEL: Record<MemoryScope, string> = {
  team: "Team",
  project: "Project",
  personal: "Yours, in every project",
  "personal-project": "Yours, in this project",
};

/** Pending changes to one file, on the lines as they were when the first change was made. */
export interface MemoryDraft {
  readonly baseRevision: string;
  readonly lines: ReadonlyArray<MemoryLine>;
  readonly edits: MemoryEdits;
}

type Editing =
  | { readonly kind: "row"; readonly index: number }
  | { readonly kind: "new"; readonly position: number };

/** One memory file as rows, each with who last wrote it, changed row by row as one pull request. */
export function MemoryDocumentSection(props: {
  readonly threadRef: ScopedThreadRef;
  readonly source: string | null;
  readonly document: MemoryDocument;
  readonly draft: MemoryDraft | null;
  readonly editBlocked: string | null;
  readonly saving: boolean;
  readonly failure: string | null;
  readonly pullRequest: TeamCatalogProposal | undefined;
  readonly onEditsChange: (edits: MemoryEdits) => void;
  readonly onDiscard: () => void;
  readonly onPropose: () => void;
}) {
  const { document, draft, pullRequest } = props;
  const openLink = useOpenLink(props.threadRef);
  const [editing, setEditing] = useState<Editing | null>(null);
  const lines = draft?.lines ?? document.lines;
  const edits = draft?.edits ?? NO_EDITS;
  const rows = memoryRows(lines);
  const changes = changeCount(edits);
  const label = SCOPE_LABEL[document.scope];

  const change = (next: MemoryEdits) => {
    setEditing(null);
    props.onEditsChange(next);
  };
  const attribution = (line: MemoryLine, prefix = "") =>
    line.author === null && line.pullRequest === null ? null : (
      <MemoryAttribution
        line={line}
        prefix={prefix}
        pullRequestUrl={
          line.pullRequest === null ? null : pullRequestUrl(props.source, line.pullRequest)
        }
        onOpen={(url, event) => void openLink(url, { event }).catch(() => undefined)}
      />
    );
  // While a new row is being written it shows after the ones already added.
  const newRows =
    editing?.kind === "new" && editing.position === edits.added.length
      ? [...edits.added, ""]
      : edits.added;
  const undo = (index: number, what: string) => (
    <>
      {what} ·{" "}
      <button
        type="button"
        className="underline underline-offset-2 hover:text-foreground"
        onClick={() => change(restoreRow(edits, index))}
      >
        Undo
      </button>
    </>
  );

  return (
    <div className="space-y-2">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">
            {document.scope === "project" && document.label !== null
              ? `${label} · ${document.label}`
              : label}
          </div>
          {document.file !== null && (
            <div className="truncate text-xs text-muted-foreground">
              <code>{document.file}</code>
            </div>
          )}
        </div>
        {document.file !== null ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <span>
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={props.editBlocked !== null || props.saving}
                    onClick={() => setEditing({ kind: "new", position: edits.added.length })}
                  >
                    <PlusIcon />
                    Add
                  </Button>
                </span>
              }
            />
            <TooltipPopup>{props.editBlocked ?? "Add a memory to this file"}</TooltipPopup>
          </Tooltip>
        ) : null}
      </div>

      {document.file === null ? (
        <p className="text-sm text-muted-foreground">{document.unavailable}</p>
      ) : (
        <div className="space-y-0.5">
          {rows.length === 0 && edits.added.length === 0 && editing?.kind !== "new" ? (
            <p className="text-sm text-muted-foreground">Nothing saved here yet.</p>
          ) : null}
          {rows.map((row) => {
            if (row.kind === "heading") {
              return (
                <div
                  key={row.index}
                  className="pt-2 pb-0.5 text-xs font-semibold text-muted-foreground first:pt-0"
                >
                  {row.text}
                </div>
              );
            }
            const edited = edits.edited[row.index];
            const removed = edits.removed.includes(row.index);
            if (editing?.kind === "row" && editing.index === row.index) {
              return (
                <MemoryRowEditor
                  key={row.index}
                  label={`Edit memory in ${label}`}
                  initialText={edited ?? row.text}
                  state={edited === undefined ? "saved" : "edited"}
                  meta={attribution(row.line, "Was by ")}
                  onDone={(text) => change(editRow(edits, row, text))}
                  onCancel={() => setEditing(null)}
                />
              );
            }
            return (
              <MemoryRowView
                key={row.index}
                text={edited ?? row.text}
                state={removed ? "removed" : edited !== undefined ? "edited" : "saved"}
                meta={
                  removed
                    ? undo(row.index, "Removed")
                    : edited !== undefined
                      ? undo(row.index, "Edited")
                      : attribution(row.line)
                }
                editBlocked={props.editBlocked ?? (props.saving ? "Proposing…" : null)}
                onEdit={() => setEditing({ kind: "row", index: row.index })}
                onRemove={() => change(removeRow(edits, row.index))}
              />
            );
          })}
          {newRows.map((text, position) =>
            editing?.kind === "new" && editing.position === position ? (
              <MemoryRowEditor
                // oxlint-disable-next-line react/no-array-index-key -- new rows have only their position
                key={`new-${position}`}
                label={`New memory in ${label}`}
                initialText={text}
                state="new"
                meta="New"
                onDone={(next) => change(setAdded(edits, position, next))}
                onCancel={() => setEditing(null)}
              />
            ) : (
              <MemoryRowView
                // oxlint-disable-next-line react/no-array-index-key -- new rows have only their position
                key={`new-${position}`}
                text={text}
                state="new"
                meta="New"
                editBlocked={props.editBlocked ?? (props.saving ? "Proposing…" : null)}
                onEdit={() => setEditing({ kind: "new", position })}
                onRemove={() => change(setAdded(edits, position, ""))}
              />
            ),
          )}
        </div>
      )}

      {changes > 0 ? (
        <div className="space-y-2 border-t pt-2">
          {props.failure !== null ? (
            <p className="text-sm text-destructive-foreground">{props.failure}</p>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            <p className="min-w-0 flex-1 text-xs text-muted-foreground">
              {changes === 1 ? "1 change" : `${changes} changes`} · opens one pull request
            </p>
            <Button size="xs" variant="ghost" disabled={props.saving} onClick={props.onDiscard}>
              Discard
            </Button>
            <Button size="xs" disabled={props.saving} onClick={props.onPropose}>
              <GitBranchIcon />
              {props.saving ? "Proposing…" : "Propose change"}
            </Button>
          </div>
        </div>
      ) : null}

      {pullRequest !== undefined && draft === null ? (
        <Alert variant="success">
          <GitBranchIcon />
          <AlertTitle>
            {pullRequest.pullRequestUrl === null
              ? "Branch pushed, pending until merged"
              : "Pull request opened, pending until merged"}
          </AlertTitle>
          <AlertDescription>
            <p>
              <code className="text-xs break-all">{pullRequest.branch}</code> changes{" "}
              {pullRequest.files.join(" and ")}. Agents get it once it is merged and fetched.
            </p>
            {pullRequest.pullRequestProblem !== null ? (
              <p>No pull request was opened: {pullRequest.pullRequestProblem}</p>
            ) : null}
            {pullRequest.pullRequestUrl !== null ? (
              <Button
                variant="outline"
                size="xs"
                onClick={(event) =>
                  void openLink(pullRequest.pullRequestUrl!, { event }).catch(() => undefined)
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
  );
}
