import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { useThreadCostEstimate } from "../../state/threadCost";
import { CostTooltip } from "./ComposerStatusStrip";
import { formatCostUsd } from "./composerStatusStrip.logic";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import { UsageRow } from "./ThreadDetailsUsage";

/** The thread's estimated cost, from the same query and wording as the status line. */
export function ThreadDetailsCost({
  environmentId,
  threadId,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const cost = useThreadCostEstimate(environmentId, threadId);
  const costUsd = cost?.costUsd ?? null;
  if (cost === null || costUsd === null) return null;
  return (
    <ThreadDetailsSection
      headingId="thread-details-cost-heading"
      title="Estimated cost"
      showHeading={false}
    >
      <div className="grid grid-cols-[auto_minmax(3rem,1fr)_auto] gap-x-3 text-xs">
        <UsageRow
          label="Cost"
          fill={null}
          tone={null}
          value={formatCostUsd(costUsd)}
          ariaValue={`about ${formatCostUsd(costUsd)}, estimated`}
          tooltip={<CostTooltip estimate={cost} costUsd={costUsd} />}
        />
      </div>
    </ThreadDetailsSection>
  );
}
