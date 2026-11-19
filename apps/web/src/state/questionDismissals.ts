import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";
import { ORCHESTRATION_V2_WS_METHODS } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";

/** Sends a question card dismissal: a `message.dispatch` the server records without a run. */
export const questionDismissalRecord = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:question-dismissal:record",
  tag: ORCHESTRATION_V2_WS_METHODS.dispatchCommand,
});
