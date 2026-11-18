import type { MemoryLine } from "@t3tools/contracts";
import { PencilIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";

import { cn } from "~/lib/utils";
import { RelativeTime } from "../RelativeTime";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { inlineCodeParts } from "./memoryRows.logic";

export type MemoryRowState = "saved" | "edited" | "removed" | "new";

const BORDER: Record<MemoryRowState, string> = {
  saved: "border-transparent",
  edited: "border-warning",
  removed: "border-transparent",
  new: "border-success",
};

/** Who last wrote a line, when, and in which pull request. */
export function MemoryAttribution(props: {
  readonly line: MemoryLine;
  readonly prefix: string;
  /** The pull request's page; null when it cannot be built from the catalog's URL. */
  readonly pullRequestUrl: string | null;
  readonly onOpen: (url: string, event: React.MouseEvent) => void;
}) {
  const { line, pullRequestUrl } = props;
  const pullRequest = line.pullRequest;
  return (
    <>
      {props.prefix}
      {line.author ?? "Unknown author"}
      {line.authoredAt !== null ? (
        <>
          {" · "}
          <RelativeTime timestamp={line.authoredAt} />
        </>
      ) : null}
      {pullRequest !== null ? (
        <>
          {" · "}
          {pullRequestUrl !== null ? (
            <button
              type="button"
              className="underline-offset-2 hover:text-foreground hover:underline"
              onClick={(event) => props.onOpen(pullRequestUrl, event)}
            >
              #{pullRequest}
            </button>
          ) : (
            `#${pullRequest}`
          )}
        </>
      ) : null}
    </>
  );
}

function MemoryText(props: { readonly text: string }) {
  return inlineCodeParts(props.text).map((part, index) =>
    part.code ? (
      // oxlint-disable-next-line react/no-array-index-key -- parts are positional and never reorder
      <code key={index} className="rounded bg-muted px-1 py-0.5 font-mono text-xs">
        {part.text}
      </code>
    ) : (
      part.text
    ),
  );
}

function RowAction(props: {
  readonly label: string;
  readonly blocked: string | null;
  readonly onClick: () => void;
  readonly children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span>
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={props.label}
              disabled={props.blocked !== null}
              onClick={props.onClick}
            >
              {props.children}
            </Button>
          </span>
        }
      />
      <TooltipPopup>{props.blocked ?? props.label}</TooltipPopup>
    </Tooltip>
  );
}

/** One memory: its text and who wrote it, with edit and remove on hover. */
export function MemoryRowView(props: {
  readonly text: string;
  readonly state: MemoryRowState;
  /** The meta line: attribution, or what is pending with its undo. */
  readonly meta: React.ReactNode;
  readonly editBlocked: string | null;
  readonly onEdit: () => void;
  readonly onRemove: () => void;
}) {
  return (
    <div
      className={cn(
        "group relative rounded-md border-s-2 py-1.5 ps-2.5 pe-16 hover:bg-muted/40",
        BORDER[props.state],
      )}
    >
      <p
        className={cn(
          "text-sm [overflow-wrap:anywhere]",
          props.state === "removed" && "text-muted-foreground line-through",
        )}
      >
        <MemoryText text={props.text} />
      </p>
      {props.meta !== null ? (
        <p className="mt-0.5 text-xs text-muted-foreground">{props.meta}</p>
      ) : null}
      {props.state !== "removed" ? (
        <div className="absolute end-1.5 top-1.5 flex gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 pointer-coarse:opacity-100">
          <RowAction label="Edit" blocked={props.editBlocked} onClick={props.onEdit}>
            <PencilIcon />
          </RowAction>
          <RowAction label="Remove" blocked={props.editBlocked} onClick={props.onRemove}>
            <Trash2Icon />
          </RowAction>
        </div>
      ) : null}
    </div>
  );
}

/** A row being written: one line of text, finished with Done or Enter. */
export function MemoryRowEditor(props: {
  readonly initialText: string;
  readonly label: string;
  readonly state: MemoryRowState;
  readonly meta: React.ReactNode;
  readonly onDone: (text: string) => void;
  readonly onCancel: () => void;
}) {
  const [text, setText] = useState(props.initialText);
  return (
    <div className={cn("space-y-1.5 rounded-md border-s-2 py-1.5 ps-2.5", BORDER[props.state])}>
      <Textarea
        aria-label={props.label}
        size="sm"
        rows={2}
        value={text}
        autoFocus
        placeholder="One memory, in plain words."
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            props.onDone(text);
          } else if (event.key === "Escape") {
            event.preventDefault();
            props.onCancel();
          }
        }}
      />
      <div className="flex flex-wrap items-center gap-2">
        <p className="min-w-0 flex-1 text-xs text-muted-foreground">{props.meta}</p>
        <Button size="xs" variant="outline" onClick={props.onCancel}>
          Cancel
        </Button>
        <Button size="xs" onClick={() => props.onDone(text)}>
          Done
        </Button>
      </div>
    </div>
  );
}
