export interface QuestionThreadInput {
  readonly openQuestionsAt?: string | null | undefined;
  readonly lastVisitedAt?: string | null | undefined;
}

/**
 * The agent asked question cards the user has not read yet. Reading the thread or replying ends it;
 * a thread nobody has opened has not been read.
 */
export function hasUnseenQuestions(thread: QuestionThreadInput): boolean {
  if (!thread.openQuestionsAt) return false;
  const askedAt = Date.parse(thread.openQuestionsAt);
  if (Number.isNaN(askedAt)) return false;
  if (!thread.lastVisitedAt) return true;
  const visitedAt = Date.parse(thread.lastVisitedAt);
  return Number.isNaN(visitedAt) || askedAt > visitedAt;
}

/**
 * A running thread with unseen questions waits on the user like one with an input request. A
 * finished one keeps its own status: its completion already asks for attention.
 */
export function withUnseenQuestions<Status extends string>(
  status: Status,
  thread: QuestionThreadInput,
): Status | "input" {
  return (status === "preparing" || status === "working" || status === "waiting") &&
    hasUnseenQuestions(thread)
    ? "input"
    : status;
}
