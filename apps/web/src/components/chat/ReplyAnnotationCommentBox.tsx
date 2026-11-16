import { ASSISTANT_CITATION_MAX_COMMENT_LENGTH, type AssistantCitation } from "@t3tools/contracts";
import { ArrowUpIcon, Trash2Icon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { TextFieldSpeechControls, useTextFieldSpeech } from "~/speech/useTextFieldSpeech";
import { textDirection } from "~/textDirection";
import { Button } from "../ui/button";

/** The one-line comment box an annotation opens on the thread. */
export function ReplyAnnotationCommentBox({
  citation,
  onSave,
  onCancel,
  onRemove,
  onDraftChange,
}: {
  citation: AssistantCitation;
  onSave: (comment: string) => void;
  onCancel: () => void;
  onRemove: () => void;
  onDraftChange: (comment: string) => void;
}) {
  const [comment, setComment] = useState(citation.comment ?? "");
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const updateComment = (text: string) => {
    setComment(text);
    onDraftChange(text);
  };
  const speech = useTextFieldSpeech({
    environmentId: citation.environmentId,
    ownerKey: JSON.stringify([
      "reply-annotation",
      citation.threadId,
      citation.messageId,
      citation.start,
      citation.end,
    ]),
    text: comment,
    textareaRef,
    onTextChange: updateComment,
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- focuses the box when it opens and puts the caret after an existing comment
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.focus({ preventScroll: true });
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  }, []);
  const tooLong = comment.length > ASSISTANT_CITATION_MAX_COMMENT_LENGTH;
  const save = () =>
    speech.submitAfterDictation((text) => {
      if (text.length <= ASSISTANT_CITATION_MAX_COMMENT_LENGTH) onSave(text);
    });

  return (
    <div
      className="flex items-end gap-1"
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.nativeEvent.isComposing || event.keyCode === 229) return;
        if (event.key === "Escape") {
          event.preventDefault();
          if (speech.state.phase !== "idle") speech.cancel();
          else onCancel();
        }
      }}
    >
      <textarea
        ref={textareaRef}
        readOnly={speech.freezesEditor}
        aria-label="Comment on this annotation"
        aria-description="Enter to save; Shift+Enter for a new line; Escape to close."
        aria-invalid={tooLong || undefined}
        placeholder="Add an optional comment..."
        rows={1}
        dir={textDirection(comment)}
        className="field-sizing-content block max-h-40 min-h-8 min-w-0 flex-1 resize-none bg-transparent px-2 py-1.5 text-base outline-none placeholder:text-muted-foreground sm:text-sm"
        value={comment}
        onChange={(event) => updateComment(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (
            event.key === "Enter" &&
            !event.shiftKey &&
            !event.nativeEvent.isComposing &&
            event.keyCode !== 229
          ) {
            event.preventDefault();
            save();
          }
        }}
      />
      <TextFieldSpeechControls speech={speech} />
      <Button
        type="button"
        variant="ghost-muted"
        size="icon-sm-pill"
        aria-label="Remove annotation"
        onPointerDown={(event) => event.preventDefault()}
        onClick={onRemove}
      >
        <Trash2Icon aria-hidden="true" />
      </Button>
      <Button
        type="button"
        size="icon-sm-pill"
        aria-label={tooLong ? "Comment is too long" : "Save comment"}
        disabled={speech.preparing || (tooLong && !speech.blocksSubmission)}
        onPointerDown={(event) => event.preventDefault()}
        onClick={save}
      >
        <ArrowUpIcon aria-hidden="true" />
      </Button>
    </div>
  );
}
