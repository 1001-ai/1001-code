/** The context entries this fork adds to Codex turns. */
const FORK_CONTEXT_KEYS = [
  "t3_code_question_cards",
  "t3_code_reply_markers",
  "t3_code_back_references",
];

/**
 * Upstream's recorded turns predate the fork's question-card, reply-marker and back-reference entries, so replays
 * compare turn/start without them. CodexAdapterV2.test.ts asserts the entries themselves.
 */
export function stripForkInstructionContext(params: Record<string, unknown>): void {
  const context = params.additionalContext;
  if (typeof context !== "object" || context === null) return;
  const rest = Object.fromEntries(
    Object.entries(context).filter(([key]) => !FORK_CONTEXT_KEYS.includes(key)),
  );
  if (Object.keys(rest).length === 0) delete params.additionalContext;
  else params.additionalContext = rest;
}
