import {
  type InboxAgentDigestEntry,
  type OrchestrationMessageContext,
  ThreadId,
  inboxAgentDigestOf,
} from "@t3tools/contracts";
import { ChevronRightIcon } from "lucide-react";
import { use, useState } from "react";

import { cn } from "~/lib/utils";
import { RelativeTime } from "../RelativeTime";
import { TimelineRowCtx } from "../chat/timelineRowContext";

const KIND_LABELS: Record<InboxAgentDigestEntry["kind"], string> = {
  "thread-created": "New thread",
  "run-started": "Working",
  "run-finished": "Finished",
  "run-failed": "Failed",
  question: "Waiting for you",
  "pull-request": "Pull request",
};

/**
 * The digest the Inbox agent was given with this message: what changed in the project's threads
 * since the user's previous message. Collapsed until opened. A message without one (any other
 * thread's, or one sent while the Inbox was answering) draws nothing.
 */
export function InboxDigestCard(props: {
  readonly context: OrchestrationMessageContext | undefined;
}) {
  const digest = inboxAgentDigestOf(props.context);
  const [open, setOpen] = useState(false);
  const ctx = use(TimelineRowCtx);
  if (digest === null) return null;
  const count = digest.entries.length + digest.omitted;
  return (
    <div className="flex justify-end" data-inbox-digest="true">
      <div className="w-full max-w-[80%] rounded-xl border border-border/70 text-xs text-muted-foreground">
        <button
          type="button"
          className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left hover:text-foreground"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          <ChevronRightIcon
            aria-hidden
            className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")}
          />
          <span className="font-medium">What changed</span>
          <span>
            · {count === 0 ? "nothing new" : `${count} ${count === 1 ? "change" : "changes"}`}
          </span>
          <span className="ms-auto">
            since <RelativeTime timestamp={digest.since} />
          </span>
        </button>
        {open ? (
          <ul className="space-y-1 border-t border-border/70 px-3 py-2">
            {digest.entries.length === 0 ? (
              <li>Nothing changed in this project's threads.</li>
            ) : null}
            {digest.entries.map((entry) => (
              <li key={`${entry.kind}:${entry.threadId}:${entry.at}`} className="min-w-0">
                <span className="text-foreground">{KIND_LABELS[entry.kind]}</span>
                {" · "}
                <button
                  type="button"
                  className="underline-offset-2 hover:text-foreground hover:underline"
                  onClick={() => ctx.onOpenThread(ThreadId.make(entry.threadId))}
                >
                  {entry.title || entry.threadId}
                </button>
                {" · "}
                <RelativeTime timestamp={entry.at} />
                {entry.detail === undefined ? null : (
                  <div className="break-words">{entry.detail}</div>
                )}
              </li>
            ))}
            {digest.omitted > 0 ? <li>{digest.omitted} older changes left out.</li> : null}
          </ul>
        ) : null}
      </div>
    </div>
  );
}
