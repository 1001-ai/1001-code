import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { ChevronDownIcon, MessagesSquareIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "~/lib/utils";

import { useQuietThreadShell } from "../../state/entities";
import { InlineButton } from "../ui/button";
import { firstBodyLine, parseLinearComment, routedSenderTarget } from "./teammateMessages.logic";
import { openTeammateThreadPeek } from "./TeammateThreadPeek";

/**
 * A folded agent message's header. For a teammate's comment routed from Linear, the sender opens
 * where it came from (the sending thread here on glass, else the comment on Linear) and the
 * summary is the comment's first line, not its marker. Any other message keeps `children`, the
 * plain header.
 */
export function RoutedMessageFoldedHeader(props: {
  children: ReactNode;
  label: string;
  expanded: boolean;
  onToggle: () => void;
  text: string;
  sender: { readonly environmentId: EnvironmentId; readonly threadId: ThreadId } | null;
  environmentId: EnvironmentId;
  /** The timeline the message is in; the sending thread opens over it. */
  threadKey: string;
}) {
  const comment = parseLinearComment(props.text);
  const localSender =
    comment !== null && props.sender?.environmentId === props.environmentId
      ? scopeThreadRef(props.sender.environmentId, props.sender.threadId)
      : null;
  const senderShell = useQuietThreadShell(localSender);
  const target =
    comment === null
      ? null
      : routedSenderTarget({
          text: props.text,
          sender: props.sender,
          environmentId: props.environmentId,
          senderThreadIsLocal: senderShell !== null && senderShell.deletedAt === null,
        });
  if (comment === null || target === null) return props.children;
  const senderLabel =
    target.kind === "thread" ? (
      <InlineButton
        tone="muted"
        title="Open the sending thread"
        onClick={() =>
          openTeammateThreadPeek(
            props.threadKey,
            scopeThreadRef(target.environmentId, target.threadId),
          )
        }
      >
        {props.label}
      </InlineButton>
    ) : (
      <InlineButton
        tone="muted"
        title="Open the comment on Linear"
        render={<a href={target.url} target="_blank" rel="noreferrer" />}
      >
        {props.label}
      </InlineButton>
    );
  // Two controls side by side: the sender, and the toggle that takes the rest of the row.
  return (
    <div className="flex w-full min-w-0 items-center gap-1.5 px-3 text-sm">
      <MessagesSquareIcon className="size-4 shrink-0 stroke-2 text-muted-foreground" />
      <span className="flex min-w-0 max-w-1/2 shrink-0 overflow-hidden">{senderLabel}</span>
      <button
        type="button"
        aria-expanded={props.expanded}
        data-scroll-anchor-ignore
        onClick={props.onToggle}
        className="flex min-w-0 flex-1 items-center gap-1.5 rounded-2xl py-2 text-left focus-visible:outline-2 focus-visible:outline-ring"
      >
        <span className="shrink-0 text-muted-foreground">{comment.issue}</span>
        <span className="min-w-0 flex-1 truncate">{firstBodyLine(comment.body)}</span>
        <ChevronDownIcon
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-transform",
            props.expanded && "rotate-180",
          )}
        />
      </button>
    </div>
  );
}
