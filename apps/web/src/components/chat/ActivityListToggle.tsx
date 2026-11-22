import * as Schema from "effect/Schema";
import { ChevronDownIcon } from "lucide-react";

import { useLocalStorage } from "~/hooks/useLocalStorage";
import { cn } from "~/lib/utils";

export const ACTIVITY_LIST_SHOWN_KEY = "t3code:timeline-moments:shown";

/** Whether the activity list (the moment cards) shows, kept per browser. */
export function useActivityListShown() {
  return useLocalStorage(ACTIVITY_LIST_SHOWN_KEY, true, Schema.Boolean);
}

/** An invisible copy of the toggle's label, holding its place in a row it is drawn over. */
export function ActivityListToggleSpace() {
  return (
    <span aria-hidden className="invisible flex h-5 shrink-0 items-center gap-1 text-xs">
      <span className="size-3" />
      Activity
    </span>
  );
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
