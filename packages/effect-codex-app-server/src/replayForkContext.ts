/** The question-card context entry this fork sends on every turn without T3's MCP server. */
const FORK_QUESTION_CARD_CONTEXT_KEY = "t3_code_question_cards";

/**
 * Upstream's recorded turns predate the fork's question-card entry, so replays compare turn/start
 * without it. CodexAdapterV2.test.ts asserts the entry itself.
 */
export function stripForkQuestionCardContext(params: Record<string, unknown>): void {
  const context = params.additionalContext;
  if (typeof context !== "object" || context === null) return;
  const { [FORK_QUESTION_CARD_CONTEXT_KEY]: _questionCards, ...rest } = context as Record<
    string,
    unknown
  >;
  if (Object.keys(rest).length === 0) delete params.additionalContext;
  else params.additionalContext = rest;
}
