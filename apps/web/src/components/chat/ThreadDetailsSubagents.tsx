import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { useThreadTurnSubagents } from "../../state/threadCost";
import { SubagentsTooltip } from "./ComposerStatusStrip";
import { subagentLabel } from "./composerStatusStrip.logic";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import { UsageRow } from "./ThreadDetailsUsage";

/** The subagents running in the thread's current turn, as the status line shows them. */
export function ThreadDetailsSubagents({
  environmentId,
  threadId,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const turn = useThreadTurnSubagents(environmentId, threadId);
  const running = turn?.liveCount ?? 0;
  if (turn === null || running === 0) return null;
  return (
    <ThreadDetailsSection
      headingId="thread-details-subagents-heading"
      title="Running subagents"
      showHeading={false}
    >
      <div className="grid grid-cols-[auto_minmax(3rem,1fr)_auto] gap-x-3 text-xs">
        <UsageRow
          label="Subagents"
          fill={null}
          tone={null}
          value={`${running} running`}
          ariaValue={`${subagentLabel(running)} running`}
          tooltip={<SubagentsTooltip turn={turn} />}
        />
      </div>
    </ThreadDetailsSection>
  );
}
