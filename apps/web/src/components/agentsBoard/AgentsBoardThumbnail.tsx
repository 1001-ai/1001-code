import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";

import { useAgentsBoardMedia } from "~/state/agentsBoard";
import type { ExpandedImagePreview } from "../chat/ExpandedImagePreview";
import { Skeleton } from "../ui/skeleton";
import { agentsBoardMediaName } from "./agentsBoard.logic";

const FRAME = "h-20 w-28 shrink-0";

/**
 * One screenshot of a message, read from the server's copy of the branch while it is on screen.
 * The frame keeps its size while the image loads, so the list does not jump.
 */
export function AgentsBoardThumbnail(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly path: string;
  readonly onOpen: (preview: ExpandedImagePreview) => void;
}) {
  const result = useAgentsBoardMedia(props.environmentId, props.projectId, props.path);
  const name = agentsBoardMediaName(props.path);
  const media = AsyncResult.getOrElse(result, () => null);
  if (media === null) {
    return result._tag === "Failure" ? (
      <div
        className={`${FRAME} flex items-center justify-center rounded-md border border-dashed border-border px-2 text-center text-xs text-muted-foreground`}
      >
        Image unavailable
      </div>
    ) : (
      <Skeleton shape="card" className={FRAME} aria-label={`Loading ${name}`} />
    );
  }
  const src = `data:${media.mimeType};base64,${media.base64}`;
  return (
    <button
      type="button"
      className={`${FRAME} overflow-hidden rounded-md border border-border bg-muted outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset`}
      aria-label={`Open ${name}`}
      onClick={() => props.onOpen({ images: [{ src, name, mimeType: media.mimeType }], index: 0 })}
    >
      <img src={src} alt="" className="size-full object-cover" decoding="async" />
    </button>
  );
}
