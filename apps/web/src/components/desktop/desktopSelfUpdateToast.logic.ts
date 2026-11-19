import type { DesktopSelfUpdateState } from "@t3tools/contracts";

export const RESTART_TO_UPDATE_LABEL = "Restart to update";

export type SelfUpdateToast =
  | { readonly kind: "building"; readonly title: string; readonly description: string }
  | { readonly kind: "ready"; readonly title: string; readonly restartError?: string }
  | { readonly kind: "error"; readonly title: string; readonly description: string };

export function selfUpdateToast(
  state: DesktopSelfUpdateState | null,
  appName: string,
): SelfUpdateToast | null {
  switch (state?.status) {
    case "building":
      return {
        kind: "building",
        title: `Updating ${appName}`,
        description: "Building the new version…",
      };
    case "ready":
      return {
        kind: "ready",
        title: "Update ready",
        ...(state.restartError === undefined ? {} : { restartError: state.restartError }),
      };
    case "error":
      return { kind: "error", title: "Update failed", description: state.message };
    default:
      return null;
  }
}

export interface RestartConfirmation {
  readonly title: string;
  readonly description: string;
}

/**
 * Null when nothing is running, so the restart needs no confirmation. Agents on a server with
 * "Continue threads after restarts" on are continued by the server's restart recovery.
 */
export function restartConfirmation(input: {
  readonly stopped: number;
  readonly continuing: number;
  readonly appName: string;
}): RestartConfirmation | null {
  const running = input.stopped + input.continuing;
  if (running === 0) return null;
  const one = running === 1;
  const stops = one ? "Restarting stops it." : "Restarting stops them.";
  return {
    title: one ? "1 agent is running" : `${running} agents are running`,
    description:
      input.stopped === 0
        ? `${stops} ${one ? "It continues" : "They continue"} when ${input.appName} reopens.`
        : stops,
  };
}
