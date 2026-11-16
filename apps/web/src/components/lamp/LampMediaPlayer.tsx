import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { ChevronLeftIcon, ChevronRightIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { useComposerDraftStore } from "~/composerDraftStore";
import { useAgentsBoardMedia } from "~/state/agentsBoard";
import { useThreadShell } from "~/state/entities";
import { useAtomCommand } from "~/state/use-atom-command";
import { useVoiceAgentState, voiceAgentMediaStep } from "~/state/voiceAgent";

import { agentsBoardMediaName, agentsBoardTime } from "../agentsBoard/agentsBoard.logic";
import { ExpandedImageDialog } from "../chat/ExpandedImageDialog";
import type { ExpandedImagePreview } from "../chat/ExpandedImagePreview";
import { Button } from "../ui/button";
import { Skeleton } from "../ui/skeleton";
import { lampChatProjectId } from "./lampAgent.logic";

const FRAME = "h-56 w-full max-w-xl";

/**
 * The screenshots the agent is showing, one at a time. The agent moves through them with its
 * tool, and so can the user: both change the same place on the server, so the agent's "next"
 * follows the user's click. A click on the image opens the app's own image preview.
 */
export function LampMediaPlayer(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const media = useVoiceAgentState(props.environmentId, props.threadId)?.media ?? null;
  const chat = scopeThreadRef(props.environmentId, props.threadId);
  const projectId = lampChatProjectId(
    useThreadShell(chat),
    useComposerDraftStore((store) => store.getDraftSessionByRef(chat)),
  );
  const step = useAtomCommand(voiceAgentMediaStep, { reportFailure: false });
  const [preview, setPreview] = useState<ExpandedImagePreview | null>(null);
  const item = media?.items[media.index];
  if (media === null || item === undefined || projectId === null) return null;
  const show = (index: number | null) =>
    void step({ environmentId: props.environmentId, input: { sessionId: media.sessionId, index } });
  return (
    <div data-lamp-layer-content="" className="flex w-full flex-col items-center gap-2">
      <LampMediaImage
        // A new image starts from its own loading state, not the last one's picture.
        key={item.path}
        environmentId={props.environmentId}
        projectId={projectId}
        path={item.path}
        onOpen={setPreview}
      />
      <div className="flex items-center gap-2 text-muted-foreground text-xs">
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Previous screenshot"
          disabled={media.index === 0}
          onClick={() => show(media.index - 1)}
        >
          <ChevronLeftIcon />
        </Button>
        <span aria-live="polite">
          {item.agentId} · {agentsBoardTime(item.at)} · {media.index + 1} of {media.items.length}
        </span>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Next screenshot"
          disabled={media.index >= media.items.length - 1}
          onClick={() => show(media.index + 1)}
        >
          <ChevronRightIcon />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Put the screenshots away"
          onClick={() => show(null)}
        >
          <XIcon />
        </Button>
      </div>
      {preview !== null ? (
        <ExpandedImageDialog preview={preview} onClose={() => setPreview(null)} />
      ) : null}
    </div>
  );
}

function LampMediaImage(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly path: string;
  readonly onOpen: (preview: ExpandedImagePreview) => void;
}) {
  const result = useAgentsBoardMedia(props.environmentId, props.projectId, props.path);
  const name = agentsBoardMediaName(props.path);
  const image = AsyncResult.getOrElse(result, () => null);
  if (image === null) {
    return result._tag === "Failure" ? (
      <div
        className={`${FRAME} flex items-center justify-center rounded-lg border border-border border-dashed text-muted-foreground text-sm`}
      >
        This screenshot could not be loaded.
      </div>
    ) : (
      <Skeleton shape="card" className={FRAME} aria-label={`Loading ${name}`} />
    );
  }
  const src = `data:${image.mimeType};base64,${image.base64}`;
  return (
    <button
      type="button"
      className={`${FRAME} overflow-hidden rounded-lg border border-border bg-muted outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset`}
      aria-label={`Open ${name} at full size`}
      onClick={() => props.onOpen({ images: [{ src, name, mimeType: image.mimeType }], index: 0 })}
    >
      <img src={src} alt="" className="size-full object-contain" decoding="async" />
    </button>
  );
}
