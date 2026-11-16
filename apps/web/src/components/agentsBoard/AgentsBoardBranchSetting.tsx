import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  AGENTS_BOARD_DEFAULT_BRANCH,
  type AgentsBoardSnapshot,
  AuthSettingsWriteScope,
  type EnvironmentId,
  isAgentsBoardBranch,
  type ProjectId,
} from "@t3tools/contracts";

import { agentsBoardSetBranch, useAgentsBoard } from "~/state/agentsBoard";
import { useEnvironmentScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import { DraftInput } from "../ui/draft-input";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { AgentsBoardAgentCommand } from "./AgentsBoardAgentCommand";

type TeamBoard = Exclude<AgentsBoardSnapshot, { status: "unavailable" }>;

function branchStatus(snapshot: TeamBoard): string {
  if (snapshot.refreshing) return "Fetching…";
  switch (snapshot.status) {
    case "loading":
      return "Not fetched yet.";
    case "missing-branch":
      return "The repository has no such branch yet.";
    case "failed":
      return `Could not fetch: ${snapshot.failure}`;
    case "ready": {
      const agents = snapshot.board.agents.length;
      return `${agents} agent${agents === 1 ? "" : "s"} on this branch.`;
    }
  }
}

/**
 * Which branch of the team project's repository holds its agents' messages. Kept on this
 * environment for now, so each person sets it; the default name needs no setting.
 */
export function AgentsBoardBranchSetting(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}) {
  const snapshot = useAgentsBoard(props.environmentId, props.projectId);
  const canWrite = useEnvironmentScope(props.environmentId, AuthSettingsWriteScope);
  const setBranch = useAtomCommand(agentsBoardSetBranch, { reportFailure: false });
  if (snapshot === null || snapshot.status === "unavailable") return null;

  const notSaved = (description: string) =>
    toastManager.add(
      stackedThreadToast({ type: "error", title: "Branch name not saved", description }),
    );
  const commit = async (next: string) => {
    const branch = next.trim() === "" ? AGENTS_BOARD_DEFAULT_BRANCH : next.trim();
    if (branch === snapshot.branch) return;
    if (!isAgentsBoardBranch(branch)) {
      notSaved("Enter a branch name, such as agent-reports.");
      return;
    }
    const result = await setBranch({
      environmentId: props.environmentId,
      input: {
        projectId: props.projectId,
        branch: branch === AGENTS_BOARD_DEFAULT_BRANCH ? null : branch,
      },
    });
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      notSaved(error instanceof Error ? error.message : "An error occurred.");
    }
  };

  return (
    <div className="space-y-1.5 border-t border-border/60 px-3 py-3 sm:px-4">
      <h3 className="text-xs font-medium text-muted-foreground">Agent messages</h3>
      <p className="text-xs text-muted-foreground">
        Agents working in this project write short messages to a branch of its repository. The
        Agents board in the right panel shows them. The branch name is saved on this environment.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <DraftInput
          size="sm"
          className="w-full sm:w-64"
          value={snapshot.branch}
          onCommit={(next) => void commit(next)}
          placeholder={AGENTS_BOARD_DEFAULT_BRANCH}
          spellCheck={false}
          disabled={!canWrite}
          aria-label="Branch for agent messages"
        />
        {snapshot.branch !== AGENTS_BOARD_DEFAULT_BRANCH ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!canWrite}
            onClick={() => void commit(AGENTS_BOARD_DEFAULT_BRANCH)}
          >
            Use default
          </Button>
        ) : null}
        <span className="text-xs text-muted-foreground">{branchStatus(snapshot)}</span>
      </div>
      <p className="pt-1 text-xs text-muted-foreground">
        To have an agent write there, give it this line:
      </p>
      <AgentsBoardAgentCommand branch={snapshot.branch} />
    </div>
  );
}
