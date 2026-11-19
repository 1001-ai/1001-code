import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { BellIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { useQuietThreadShell } from "../../state/entities";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";
import { SidebarMenuButton, SidebarMenuItem, useSidebar } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { type TeammateMessage, unreadBadgeLabel } from "./teammateMessages.logic";
import {
  dismissTeammateMessages,
  useOpenTeammateMessage,
  useUnreadTeammateMessages,
} from "./teammateMessages.state";

function teammateMessagesLabel(count: number): string {
  return count === 0 ? "Teammate messages" : `Teammate messages, ${count} unread`;
}

/** The bell's count, drawn inside the svg: a wrapper span would be the menu button's last child, which it truncates. */
function BellWithCount({ count }: { count: number }) {
  const label = unreadBadgeLabel(count);
  return (
    <BellIcon aria-hidden="true" className="overflow-visible">
      {label === null ? null : (
        <>
          <circle
            cx="20"
            cy="4"
            r={label.length > 1 ? 8.5 : 7.5}
            strokeWidth="3"
            className="fill-primary stroke-sidebar in-[[data-slot=sidebar-menu-button]:hover]:stroke-sidebar-row-hover"
          />
          <text
            x="20"
            y="4"
            textAnchor="middle"
            dominantBaseline="central"
            fontSize={label.length > 1 ? 9 : 11}
            fontWeight="700"
            strokeWidth="0"
            className="fill-primary-foreground"
          >
            {label}
          </text>
        </>
      )}
    </BellIcon>
  );
}

/** The sidebar footer's bell: teammates' comments routed into threads here, until opened or dismissed. */
export function TeammateMessagesButton() {
  const messages = useUnreadTeammateMessages();
  const [open, setOpen] = useState(false);
  const { isMobile, setOpenMobile } = useSidebar();
  const openMessage = useOpenTeammateMessage();
  const label = teammateMessagesLabel(messages.length);
  return (
    <SidebarMenuItem className="shrink-0">
      <Popover open={open} onOpenChange={setOpen}>
        <Tooltip>
          <TooltipTrigger
            render={
              <PopoverTrigger render={<SidebarMenuButton aria-label={label} size="icon" />} />
            }
          >
            <BellWithCount count={messages.length} />
          </TooltipTrigger>
          <TooltipPopup side="top">{label}</TooltipPopup>
        </Tooltip>
        <PopoverPopup side="top" align="start" width="md" padding="compact">
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-2">
              <PopoverTitle>Teammate messages</PopoverTitle>
              {messages.length > 1 ? (
                <Button
                  variant="ghost-muted"
                  size="compact"
                  onClick={() => dismissTeammateMessages(messages.map((message) => message.nonce))}
                >
                  Dismiss all
                </Button>
              ) : null}
            </div>
            {messages.length === 0 ? (
              <p className="py-2 text-muted-foreground text-sm">
                No unread messages from teammates.
              </p>
            ) : (
              <ul className="-mx-1 flex max-h-96 flex-col overflow-y-auto">
                {messages.map((message) => (
                  <TeammateMessageRow
                    key={message.nonce}
                    message={message}
                    onOpen={() => {
                      setOpen(false);
                      if (isMobile) setOpenMobile(false);
                      void openMessage(message);
                    }}
                  />
                ))}
              </ul>
            )}
          </div>
        </PopoverPopup>
      </Popover>
    </SidebarMenuItem>
  );
}

function TeammateMessageRow(props: { message: TeammateMessage; onOpen: () => void }) {
  const { message } = props;
  const shell = useQuietThreadShell(scopeThreadRef(message.environmentId, message.threadId));
  return (
    <li className="flex items-start gap-1 rounded-md hover:bg-accent">
      <button
        type="button"
        className="flex min-w-0 flex-1 flex-col gap-0.5 rounded-md px-2 py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        onClick={props.onOpen}
      >
        <span className="flex min-w-0 items-baseline gap-1.5 text-sm">
          <span className="truncate font-medium text-foreground">{message.sender}</span>
          <span className="shrink-0 text-muted-foreground text-xs">{message.issue}</span>
          <span className="ms-auto shrink-0 text-muted-foreground text-xs tabular-nums">
            {formatRelativeTimeLabel(message.at)}
          </span>
        </span>
        <span className="truncate text-muted-foreground text-xs">
          {shell?.title.trim() || "Thread"}
        </span>
        {message.preview === "" ? null : (
          <span className="truncate text-foreground text-xs">{message.preview}</span>
        )}
      </button>
      <Button
        variant="ghost-muted"
        size="icon-xs"
        aria-label={`Dismiss the message from ${message.sender}`}
        className="mt-1 me-1"
        onClick={() => dismissTeammateMessages([message.nonce])}
      >
        <XIcon />
      </Button>
    </li>
  );
}
