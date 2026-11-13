import * as Schema from "effect/Schema";

import { NonNegativeInt, ThreadId } from "./baseSchemas.ts";

export const ThreadCostEstimateInput = Schema.Struct({
  threadId: ThreadId,
});
export type ThreadCostEstimateInput = typeof ThreadCostEstimateInput.Type;

/**
 * API-equivalent cost of a thread and the subagent threads below it, priced from each provider
 * turn's token report with the rates the Usage page uses. Not a subscription bill.
 */
export const ThreadCostEstimate = Schema.Struct({
  /** Null when no turn could be priced, so clients never show a made-up $0. */
  costUsd: Schema.NullOr(Schema.Number),
  pricedTurns: NonNegativeInt,
  /** Turns with tokens for a model that has no known or custom price. */
  unpricedTurns: NonNegativeInt,
  /** Finished turns whose provider reported no tokens. */
  unreportedTurns: NonNegativeInt,
  /** Subagent threads included, not counting this one. */
  subagentThreads: NonNegativeInt,
});
export type ThreadCostEstimate = typeof ThreadCostEstimate.Type;

export class ThreadCostEstimateError extends Schema.TaggedError<ThreadCostEstimateError>()(
  "ThreadCostEstimateError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}
