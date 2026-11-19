import {
  type ChatAttachment,
  type ChatFileAttachment,
  type ChatImageAttachment,
  isFileAttachment,
  isImageAttachment,
  isVideoAttachment,
} from "../../types";
import type { ComposerContextRecord, KnownComposerContextRecord } from "@t3tools/contracts";
import type { resolveUserMessagePresentation } from "@t3tools/client-runtime/user-message";
import { replaceComposerContextReferences } from "@t3tools/shared/composerContextReferences";
import { filePreviewKind } from "@t3tools/shared/filePreview";
import {
  asKnownContextRecord,
  type ResolvedUserMessageContext,
} from "~/lib/composerContextRecords";

export function userMessageFileLabel(file: Pick<ChatFileAttachment, "name" | "source">) {
  return file.source?._tag === "pasted-text" ? "Pasted text" : file.name;
}

export function resolvePreviewAnnotationImage(input: {
  record: Extract<KnownComposerContextRecord, { kind: "preview-annotation" }>;
  recordsById: ReadonlyMap<string, ComposerContextRecord>;
  userImages: ReadonlyArray<ChatImageAttachment>;
  previewImages: ReadonlyArray<ChatImageAttachment>;
  annotationRecordIds: ReadonlyArray<string>;
}): ChatImageAttachment | null {
  const screenshotRecord = input.record.screenshotContextId
    ? asKnownContextRecord(input.recordsById.get(input.record.screenshotContextId))
    : undefined;
  return (
    (screenshotRecord?.kind === "image"
      ? input.userImages.find((image) => image.id === screenshotRecord.attachmentId)
      : undefined) ??
    input.previewImages.find(
      (image) => image.name === `preview-annotation-${input.record.annotationId}.png`,
    ) ??
    input.previewImages[input.annotationRecordIds.indexOf(input.record.contextId)] ??
    null
  );
}

/**
 * A message of only file cards or only voice notes, which renders no message body. `context` is
 * resolved from the presented text; a reference to one of those attachments is not words.
 */
export function userMessageAttachmentsOnly(input: {
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly context: Pick<ResolvedUserMessageContext, "text" | "recordsById">;
  readonly attribution: ReturnType<typeof resolveUserMessagePresentation>["attribution"];
}): "file-cards" | "audio" | null {
  if (input.attribution === "agent" || input.attribution === "guest") return null;
  const files = input.attachments.filter(isFileAttachment);
  const videos = files.filter(isVideoAttachment);
  const audio = files.filter(
    (file) => file.downloadable !== false && filePreviewKind(file) === "audio",
  );
  const otherFiles = files.filter((file) => !isVideoAttachment(file) && !audio.includes(file));
  const images = input.attachments
    .filter(isImageAttachment)
    .filter((image) => !image.name.startsWith("preview-annotation-"));
  const unknown = input.attachments.filter(
    (attachment) => !isImageAttachment(attachment) && !isFileAttachment(attachment),
  );
  const onlyReferencesTo = (shown: ReadonlyArray<ChatFileAttachment>) =>
    replaceComposerContextReferences(input.context.text, (reference) => {
      const record = asKnownContextRecord(input.context.recordsById.get(reference.contextId));
      return (record?.kind === "file" || record?.kind === "image") &&
        shown.some((file) => file.id === record.attachmentId)
        ? ""
        : reference.label;
    }).trim() === "";
  if (
    otherFiles.length > 0 &&
    images.length + videos.length + audio.length + unknown.length === 0 &&
    onlyReferencesTo(otherFiles)
  )
    return "file-cards";
  if (
    audio.length > 0 &&
    images.length + videos.length + otherFiles.length + unknown.length === 0 &&
    onlyReferencesTo(audio)
  )
    return "audio";
  return null;
}
