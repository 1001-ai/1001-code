import type { PullRequestSummary } from "@t3tools/contracts";

// `#115`, `repo#115` or `owner/repo#115`: text that only names the pull request.
const SHORT_REFERENCE = /^(?:[\w.-]+(?:\/[\w.-]+)?)?#([1-9][0-9]*)$/u;

/** Whether a link's text is a short reference to the pull request it links, so it shows as a chip. */
export function isPullRequestChipText(text: string | null, number: number): boolean {
  const match = text === null ? null : SHORT_REFERENCE.exec(text.trim());
  return match !== null && Number(match[1]) === number;
}

export type PullRequestChipState = "open" | "draft" | "merged" | "closed";

/** The state the chip shows; null while no thread link or earlier read has told the client. */
export function pullRequestChipState(
  summary: Pick<PullRequestSummary, "state" | "isDraft"> | null,
): PullRequestChipState | null {
  if (summary === null) return null;
  return summary.state === "open" && summary.isDraft ? "draft" : summary.state;
}

function repositoryName(repository: string): string {
  return repository.slice(repository.lastIndexOf("/") + 1);
}

/**
 * `#115` for a pull request of the thread's repository, `repo#115` for another, and
 * `owner/repo#115` when another repository shares the thread repository's name, such as a fork.
 */
export function pullRequestChipLabel(input: {
  readonly repository: string;
  readonly number: number;
  readonly threadRepository: string | null;
}): string {
  const repository = input.repository.toLowerCase();
  const threadRepository = input.threadRepository?.toLowerCase() ?? null;
  if (repository === threadRepository) return `#${input.number}`;
  const name = repositoryName(input.repository);
  const sharesName =
    threadRepository !== null && repositoryName(threadRepository) === name.toLowerCase();
  return `${sharesName ? input.repository : name}#${input.number}`;
}
