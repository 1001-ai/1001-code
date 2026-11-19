import type { ScopedThreadRef } from "@t3tools/contracts";

import { useComposerDraftStore } from "../../composerDraftStore";
import { dispatchSnapShotComposerFocus } from "../../lib/desktopSnapShot";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { environmentThreadShells } from "../../state/threads";
import { type MessageFromInboxPlan, planMessageFromInbox } from "./messageFromInbox.logic";

export function messageFromInboxPlan(
  selected: Parameters<typeof planMessageFromInbox>[0],
): MessageFromInboxPlan | null {
  return planMessageFromInbox(selected, (environmentId) =>
    appAtomRegistry.get(environmentThreadShells.environmentThreadsAtom(environmentId)),
  );
}

/** Opens the Inbox with the selected threads as chips in its composer, then focuses it. */
export async function messageFromInbox(
  plan: MessageFromInboxPlan | null,
  openThread: (ref: ScopedThreadRef) => Promise<unknown>,
): Promise<void> {
  if (plan === null || plan.inbox === null) return;
  useComposerDraftStore.getState().addThreadContexts(plan.inbox, plan.recipients);
  await openThread(plan.inbox);
  // An Inbox already on screen gets no thread-open focus, and the closing menu restores its own.
  window.requestAnimationFrame(dispatchSnapShotComposerFocus);
}
