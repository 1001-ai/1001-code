/** The server sets this once at startup, only when it runs in dev mode from a git checkout. */
let liveAppCheckout: string | undefined;

export function setLiveAppCheckout(checkout: string | undefined): void {
  liveAppCheckout = checkout;
}

function buildLiveAppCheckoutInstructions(checkout: string): string {
  return `<live_app_checkout>
The T3 Code app the user is using runs in dev mode from the git checkout ${checkout}. This applies only when you change that app's own code.
- Web (renderer) changes in that checkout hot-reload into the running app within a second; nothing restarts and running turns keep going. To show the user a web change, build it in your own worktree, run \`git -C ${checkout} status\`, then apply your diff there without committing: \`git -C <your worktree> diff <base branch>... | git -C ${checkout} apply\`. Never start a separate dev server to show it.
- That status can list other agents' applied, unmerged diffs, even to the feature you are changing. Build on what the user actually sees.
- Server, contracts, desktop-shell and shared-package changes restart the backend and end running turns, yours included. Do not apply them; tell the user they need to restart the app.
- After your PR merges, run \`git -C ${checkout} checkout -- <your files>\`, then fetch and fast-forward the checkout to the merged base branch. Leave other agents' applied diffs alone.
- Your shell inherits T3CODE_HOME and T3CODE_PORT_OFFSET from the app. Unset both, or point T3CODE_HOME (or the dev script's --home-dir) at a separate test home, before starting a test server from any checkout.
</live_app_checkout>`;
}

/** Empty unless the server found its live checkout. */
function liveAppCheckoutInstructions(): string {
  return liveAppCheckout === undefined ? "" : buildLiveAppCheckoutInstructions(liveAppCheckout);
}

export function appendLiveAppCheckout(instructions: string, enabled = true): string {
  const liveCheckout = enabled ? liveAppCheckoutInstructions() : "";
  return liveCheckout ? `${instructions}\n\n${liveCheckout}` : instructions;
}

/** Codex caps each context entry, so the text gets its own. */
export function liveAppCheckoutCodexContext(): Record<
  string,
  { readonly kind: "application"; readonly value: string }
> {
  const value = liveAppCheckoutInstructions();
  return value ? { t3_code_live_app_checkout: { kind: "application", value } } : {};
}
