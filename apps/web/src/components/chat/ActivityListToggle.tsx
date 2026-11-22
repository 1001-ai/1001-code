import * as Schema from "effect/Schema";
import { ChevronDownIcon } from "lucide-react";

import { useLocalStorage } from "~/hooks/useLocalStorage";
import { cn } from "~/lib/utils";

export const ACTIVITY_LIST_SHOWN_KEY = "t3code:timeline-moments:shown";

/** Whether the activity list (the moment cards) shows, kept per browser. */
export function useActivityListShown() {
  return useLocalStorage(ACTIVITY_LIST_SHOWN_KEY, true, Schema.Boolean);
}

export function ActivityListToggle(props: {
  readonly shown: boolean;
  readonly onToggle: () => void;
}) {
  return (
    <button
      type="button"
      aria-expanded={props.shown}
      data-testid="activity-list-toggle"
      className="pointer-events-auto flex h-5 shrink-0 cursor-pointer items-center gap-1 rounded-sm text-muted-foreground text-xs hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      onClick={props.onToggle}
    >
      <ChevronDownIcon
        aria-hidden
        className={cn("size-3 shrink-0 transition-transform", !props.shown && "-rotate-90")}
      />
      Activity
    </button>
  );
}
