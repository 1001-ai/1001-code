import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { MessageSquareTextIcon, XIcon } from "lucide-react";
import type { DraftId } from "~/composerDraftStore";
import { assistantCitationNavigation } from "~/lib/assistantCitationNavigation";
import { useQuietThreadShell } from "~/state/entities";
import { textDirection } from "~/textDirection";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import {
  removeReplyAnnotation,
  useReplyAnnotations,
  type ReplyAnnotation,
} from "./replyAnnotations";

/** The composer's "N annotations" pill; its list jumps to each quote or removes it. */
export function ReplyAnnotationsPill({ target }: { target: ScopedThreadRef | DraftId }) {
  const annotations = useReplyAnnotations(target);
  if (annotations.length === 0) return null;
  const label = `${annotations.length} ${annotations.length === 1 ? "annotation" : "annotations"}`;
  return (
    <div className="mb-2 flex">
      <Popover>
        <PopoverTrigger render={<Button type="button" variant="outline" size="compact" />}>
          <MessageSquareTextIcon aria-hidden="true" />
          {label}
        </PopoverTrigger>
        <PopoverPopup side="top" align="start" padding="compact" width="md">
          <ol aria-label={label} className="flex flex-col gap-1">
            {annotations.map((annotation, index) => (
              <AnnotationRow
                key={annotation.id}
                annotation={annotation}
                number={index + 1}
                onRemove={() => removeReplyAnnotation(annotation.id)}
              />
            ))}
          </ol>
        </PopoverPopup>
      </Popover>
    </div>
  );
}

function AnnotationRow({
  annotation,
  number,
  onRemove,
}: {
  annotation: ReplyAnnotation;
  number: number;
  onRemove: () => void;
}) {
  const { citation } = annotation;
  const navigate = useNavigate();
  const sourceThread = useQuietThreadShell(
    scopeThreadRef(citation.environmentId, citation.threadId),
  );
  return (
    <li className="flex items-start gap-2">
      <button
        type="button"
        className="flex min-w-0 flex-1 items-start gap-2 rounded-md p-1 text-left text-sm hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
        onClick={() => void navigate(assistantCitationNavigation(citation, sourceThread))}
      >
        <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-info font-semibold text-white text-xs">
          {number}
        </span>
        <span className="flex min-w-0 flex-col">
          <span dir={textDirection(citation.text)} className="line-clamp-2 text-muted-foreground">
            “{citation.text.trim()}”
          </span>
          {citation.comment ? (
            <span dir={textDirection(citation.comment)} className="line-clamp-3 text-foreground">
              {citation.comment}
            </span>
          ) : null}
        </span>
      </button>
      <Button
        type="button"
        variant="ghost-muted"
        size="icon-micro"
        aria-label={`Remove annotation ${number}`}
        onClick={onRemove}
      >
        <XIcon aria-hidden="true" />
      </Button>
    </li>
  );
}
