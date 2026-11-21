import { agentsBoardAgentCommand } from "@t3tools/contracts";
import { CheckIcon, CopyIcon } from "lucide-react";

import { namedClipboardTarget, useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** The one line a person gives an agent so it reads the branch's instructions, with a copy button. */
export function AgentsBoardAgentCommand(props: {
  readonly branch: string;
  /** The repository that holds the branch, when it is not the project's own. */
  readonly repository: string | undefined;
}) {
  const command = agentsBoardAgentCommand(props.branch, props.repository);
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    target: namedClipboardTarget("the line for an agent"),
  });
  return (
    <div className="flex items-center gap-1.5 rounded-md border border-border bg-muted/50 py-1 ps-2.5 pe-1">
      <code className="min-w-0 flex-1 text-start font-mono text-xs wrap-anywhere select-all">
        {command}
      </code>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              aria-label="Copy the line for an agent"
              onClick={() => copyToClipboard(command)}
            >
              {isCopied ? <CheckIcon /> : <CopyIcon />}
            </Button>
          }
        />
        <TooltipPopup>{isCopied ? "Copied" : "Copy"}</TooltipPopup>
      </Tooltip>
    </div>
  );
}
