import { FORK_DESKTOP } from "@t3tools/contracts";

import { QUESTION_CARD_INSTRUCTIONS } from "./questionCardInstructions.ts";
import { appendLiveAppCheckout } from "./liveCheckoutInstructions.ts";
import { REPLY_MARKER_INSTRUCTIONS } from "./replyMarkerInstructions.ts";
import { BACK_REFERENCE_INSTRUCTIONS } from "./backReferenceInstructions.ts";

export { QUESTION_CARD_INSTRUCTIONS };
export { REPLY_MARKER_INSTRUCTIONS, replyMarkerCodexContext } from "./replyMarkerInstructions.ts";
export {
  BACK_REFERENCE_INSTRUCTIONS,
  backReferenceCodexContext,
} from "./backReferenceInstructions.ts";
export { liveAppCheckoutCodexContext, setLiveAppCheckout } from "./liveCheckoutInstructions.ts";
export * from "./voiceAgentInstructions.ts";
export * from "./inboxAgentInstructions.ts";

/** Session-invariant; harnesses with a native system-prompt append can carry it once per session. */
export const PULL_REQUEST_LINKING_INSTRUCTIONS = `<pull_request_linking>
Link each PR you create, take over, or push to: link_pull_request, or link_pull_requests for several, full URL, every stack layer, as your next call. Host tools don't link for you. If linking fails, say so. Skip PRs you only read or review and PRs named only as background. Call watch_pull_request when asked to monitor or babysit, or when work you were asked to do, such as a merge, still waits on checks or reviews, even after an earlier unwatch. Finish any needed branch update and push first, then watch and end your turn. Otherwise act now or hand back. Delegated children never watch, even if the brief says babysit. After PR work, a child's last line is: PR <full URL>, head <SHA>, checks and reviews <state>. Links and watches persist across pushes. For PR waits, no sleep, loops, gh --watch, Monitor or ScheduleWakeup. Before handback, call unwatch_pull_request on any PR you watch. When pull_request_* tools are listed, use them, not gh or cafe, to read, list, open, edit, review, reply on, close, or merge PRs, and ci_logs and ci_rerun for their checks. pull_request_create links for you.
If available, call link_issue for each issue you take on or file, even via CLI; skip issues you only read.
</pull_request_linking>`;

/** Omit model and effort when the harness manages them dynamically. */
export function buildRuntimeInstructions(runtime: {
  readonly harness: string;
  readonly model?: string | undefined;
  readonly modelName?: string | undefined;
  readonly reasoningEffort?: string | undefined;
  /** False when the session's system prompt already carries the linking instructions. */
  readonly pullRequestLinking?: boolean;
  /** False when the caller sends the live checkout text in its own entry. */
  readonly liveAppCheckout?: boolean;
  /** False when the caller sends the reply marker text in its own entry. */
  readonly replyMarkers?: boolean;
  /** False when the caller sends the back-reference text in its own entry. */
  readonly backReferences?: boolean;
}): string {
  const harness = toSingleLine(runtime.harness);
  const model = toSingleLine(runtime.model ?? "");
  const modelName = toSingleLine(runtime.modelName ?? "");
  const effort = toSingleLine(runtime.reasoningEffort ?? "");
  const modelLabel =
    modelName && modelName !== model ? `${modelName} (model slug: ${model})` : model;
  const modelInfo = model && model !== "auto" && model !== "default" ? `, as ${modelLabel}` : "";
  const effortInfo = effort ? ` with ${effort} reasoning effort` : "";
  const runtimeInfo = `<runtime_info>In case you're asked: you are running in ${FORK_DESKTOP.productName} through the ${harness} harness${modelInfo}${effortInfo}. No need to mention this otherwise. You can embed images, video, and audio using Markdown image syntax with absolute file paths. Link every other file you cite or produce by its absolute path, as in [http.ts:42](/abs/path/http.ts:42), so the user can open it in ${FORK_DESKTOP.productName}'s files viewer.</runtime_info>`;
  return appendLiveAppCheckout(
    runtime.pullRequestLinking === false
      ? runtimeInfo
      : `${runtimeInfo}\n\n${PULL_REQUEST_LINKING_INSTRUCTIONS}\n\n${QUESTION_CARD_INSTRUCTIONS}${runtime.replyMarkers === false ? "" : `\n\n${REPLY_MARKER_INSTRUCTIONS}`}${runtime.backReferences === false ? "" : `\n\n${BACK_REFERENCE_INSTRUCTIONS}`}`,
    runtime.liveAppCheckout,
  );
}

function toSingleLine(value: string): string {
  return value.replaceAll(/\s+/g, " ").trim();
}
