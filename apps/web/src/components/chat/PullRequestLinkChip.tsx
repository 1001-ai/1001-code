import type { EnvironmentId, PullRequestRef, ScopedThreadRef } from "@t3tools/contracts";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { useMessages } from "gt-react";

import { PULL_REQUEST_STATE_PRESENTATION } from "~/components/pullRequest/pullRequestIcons";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { readThreadShell } from "~/state/entities";
import { useSharedPullRequestSummary } from "~/state/pullRequests";

import { ContextChip, ContextChipLabel } from "../ContextChip";
import { PULL_REQUEST_CHIP_KINDS } from "../contextChipParts";
import {
  isPullRequestChipText,
  pullRequestChipLabel,
  pullRequestChipState,
} from "./pullRequestLinkChip.logic";

export interface PullRequestLinkChipProps {
  readonly target: { readonly environmentId: EnvironmentId; readonly input: PullRequestRef };
  readonly label: string;
}

/**
 * The chip a markdown link to a pull request shows: one whose text only names it. The markdown
 * keeps the link as written; only this client draws it as a chip.
 */
export function pullRequestLinkChip(input: {
  readonly target: PullRequestLinkChipProps["target"] | null;
  readonly text: string | null;
  readonly isAutolink: boolean;
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly threadRef: ScopedThreadRef | undefined;
}): PullRequestLinkChipProps | null {
  const { target } = input;
  if (target === null || input.isAutolink) return null;
  if (!isPullRequestChipText(input.text, target.input.number)) return null;
  // The thread's project never changes, so reading its shell once per render is enough.
  const threadProjectId = input.threadRef ? readThreadShell(input.threadRef)?.projectId : undefined;
  const threadProject = input.projects.find(
    (project) => project.environmentId === target.environmentId && project.id === threadProjectId,
  );
  return {
    target,
    label: pullRequestChipLabel({
      repository: target.input.repository,
      number: target.input.number,
      threadRepository:
        sourceControlClients.repositorySelector(threadProject?.repositoryIdentity) ?? null,
    }),
  };
}

/** A pull request link's content as a chip with its state's icon and color. */
export function PullRequestLinkChip({ target, label }: PullRequestLinkChipProps) {
  const m = useMessages();
  const state = pullRequestChipState(
    useSharedPullRequestSummary(target.environmentId, target.input),
  );
  const Icon = PULL_REQUEST_STATE_PRESENTATION[state ?? "open"].Icon;
  return (
    <ContextChip kind={state === null ? "neutral" : PULL_REQUEST_CHIP_KINDS[state]}>
      {state === null ? (
        <Icon aria-hidden />
      ) : (
        <Icon role="img" aria-label={m(PULL_REQUEST_STATE_PRESENTATION[state].label)} />
      )}
      <ContextChipLabel className="[a:hover_&]:decoration-current">{label}</ContextChipLabel>
    </ContextChip>
  );
}
