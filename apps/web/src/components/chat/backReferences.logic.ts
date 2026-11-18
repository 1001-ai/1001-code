import { isWorkflowScriptMessage } from "@t3tools/client-runtime/state/subagentRuntime";
import { resolveUserMessagePresentation } from "@t3tools/client-runtime/user-message";
import type {
  ComposerContextId,
  OrchestrationMessageContext,
  OrchestrationV2Actor,
  OrchestrationV2CreationSource,
} from "@t3tools/contracts";
import {
  findBackReferences,
  findQuotedMessage,
  markdownDisplayText,
  quoteWords,
  type QuoteMatch,
  type QuoteWords,
} from "@t3tools/shared/backReferences";
import { formatComposerContextHref } from "@t3tools/shared/composerContextReferences";
import { splitReLines } from "@t3tools/shared/replyMarkers";
import type { PhrasingContent, Root, RootContent } from "mdast";

import { resolveUserMessageContext } from "~/lib/composerContextRecords";
import type { ChatAttachment } from "../../types";
import { userMessageAttachmentsOnly } from "./TimelineUserMessageRow.logic";

/** A finished chat message a back-reference can point at, in timeline order. */
export interface BackReferenceSource<M extends string = string> {
  readonly itemId: string;
  readonly messageId: M;
  /** The message's markdown, as the timeline renders it. */
  readonly text: string;
}

export interface BackReferenceTarget<M extends string = string> {
  readonly messageId: M;
  readonly kind: QuoteMatch["kind"];
}

interface TurnItemLike<M extends string> {
  readonly item: {
    readonly id: string;
    readonly type: string;
    readonly text?: unknown;
    readonly messageId?: M;
    readonly streaming?: unknown;
    readonly scheduledTaskId?: unknown;
    readonly workflowScript?: boolean | undefined;
    readonly createdBy?: OrchestrationV2Actor | undefined;
    readonly creationSource?: OrchestrationV2CreationSource | undefined;
    readonly context?: OrchestrationMessageContext | undefined;
    readonly attachments?: ReadonlyArray<ChatAttachment> | undefined;
  };
}

const sourceByItem = new WeakMap<object, BackReferenceSource | null>();

/** The text a message's row shows where a reveal searches, or null when the row cannot reveal. */
function revealableText<M extends string>(item: TurnItemLike<M>["item"]): string | null {
  const { type, text, messageId } = item;
  if (typeof text !== "string") return null;
  // Re: lines render above the reply, outside the text the reveal searches.
  if (type === "assistant_message") {
    return item.streaming === true ? null : (splitReLines(text)?.body ?? text);
  }
  // Automation prompts, workflow openings and attachment-only messages mount no reveal.
  if (type !== "user_message" || item.scheduledTaskId !== undefined) return null;
  const message = { role: "user", text, workflowScript: item.workflowScript };
  if (isWorkflowScriptMessage(message)) return null;
  const presented = resolveUserMessagePresentation({
    ...message,
    ...(messageId === undefined ? {} : { id: messageId }),
    ...(item.createdBy === undefined ? {} : { createdBy: item.createdBy }),
    ...(item.creationSource === undefined ? {} : { creationSource: item.creationSource }),
    context: item.context,
  });
  if (presented.attribution === "automation") return null;
  const context = resolveUserMessageContext({ text: presented.text, context: item.context });
  return userMessageAttachmentsOnly({
    attachments: item.attachments ?? [],
    context,
    attribution: presented.attribution,
  }) === null
    ? context.text
    : null;
}

/**
 * The finished user and assistant messages of a thread's visible items whose rows a reveal can
 * open, each with the text its row shows. Reads each item once.
 */
export function backReferenceSources<M extends string>(
  items: ReadonlyArray<TurnItemLike<M>>,
): ReadonlyArray<BackReferenceSource<M>> {
  const sources: BackReferenceSource<M>[] = [];
  for (const { item } of items) {
    let source = sourceByItem.get(item) as BackReferenceSource<M> | null | undefined;
    if (source === undefined) {
      const shown = revealableText(item);
      source =
        shown !== null && shown.trim() !== "" && item.messageId !== undefined
          ? { itemId: item.id, messageId: item.messageId, text: shown }
          : null;
      sourceByItem.set(item, source);
    }
    if (source !== null) sources.push(source);
  }
  return sources;
}

export function sameBackReferenceSources(
  left: ReadonlyArray<BackReferenceSource>,
  right: ReadonlyArray<BackReferenceSource>,
): boolean {
  return left.length === right.length && left.every((source, index) => source === right[index]);
}

const wordsBySource = new WeakMap<BackReferenceSource, QuoteWords>();

/** The words a source shows, read once per source. */
function sourceWords(source: BackReferenceSource): QuoteWords {
  let words = wordsBySource.get(source);
  if (words === undefined) {
    words = quoteWords(markdownDisplayText(source.text));
    wordsBySource.set(source, words);
  }
  return words;
}

/**
 * The earlier message a back-reference in `itemId` points at, among the messages before it: the
 * newest that holds the quoted words exactly, else the newest that holds a close match. Null when
 * none does, so the marker stays text.
 */
export function findBackReferenceTarget<M extends string>(
  sources: ReadonlyArray<BackReferenceSource<M>>,
  itemId: string,
  excerpt: string,
): BackReferenceTarget<M> | null {
  const position = sources.findIndex((source) => source.itemId === itemId);
  if (position <= 0) return null;
  const found = findQuotedMessage(sources.slice(0, position), sourceWords, excerpt);
  return found === null ? null : { messageId: found.message.messageId, kind: found.match.kind };
}

export type BackReferenceSearch<M extends string> =
  | { readonly _tag: "found"; readonly target: BackReferenceTarget<M> }
  | { readonly _tag: "not-found" }
  | { readonly _tag: "aborted" };

const MAX_HISTORY_PAGES = 20;

/**
 * Finds a back-reference's target, paging older history in while the loaded messages hold none
 * and the thread has more. `readHistory` resolves once no page is loading, or with null on abort.
 */
export async function searchBackReferenceHistory<M extends string>(input: {
  readonly find: () => BackReferenceTarget<M> | null;
  readonly readHistory: () => Promise<{ readonly hasMoreHistory: boolean } | null>;
  readonly loadPage: () => Promise<{ readonly _tag: string }>;
}): Promise<BackReferenceSearch<M>> {
  for (let pages = 0; ; pages += 1) {
    const history = await input.readHistory();
    if (history === null) return { _tag: "aborted" };
    const target = input.find();
    if (target !== null) return { _tag: "found", target };
    if (!history.hasMoreHistory || pages >= MAX_HISTORY_PAGES) return { _tag: "not-found" };
    const result = await input.loadPage();
    if (result._tag === "error" || result._tag === "noop") return { _tag: "not-found" };
  }
}

/** The context kind a back-reference renders through `renderContextReference`. */
export const BACK_REFERENCE_KIND = "back-reference";
const BACK_REFERENCE_HREF = formatComposerContextHref(
  BACK_REFERENCE_KIND,
  "ref" as ComposerContextId,
);

/**
 * Turns each `(↑ "words")` marker in prose into a `t3-context` link whose text is the marker, so
 * `renderContextReference` reads the words back from the label. Code and links keep theirs.
 */
export function remarkBackReferences() {
  return (tree: Root) => {
    const visit = (node: Root | RootContent) => {
      if (!("children" in node) || node.type === "link" || node.type === "linkReference") return;
      node.children = node.children.flatMap((child): typeof node.children => {
        if (child.type !== "text") {
          visit(child);
          return [child];
        }
        const references = findBackReferences(child.value);
        if (references.length === 0) return [child];
        const parts: PhrasingContent[] = [];
        let offset = 0;
        for (const { text, start, end } of references) {
          if (start > offset) parts.push({ type: "text", value: child.value.slice(offset, start) });
          parts.push({
            type: "link",
            url: BACK_REFERENCE_HREF,
            children: [{ type: "text", value: text }],
          });
          offset = end;
        }
        if (offset < child.value.length) {
          parts.push({ type: "text", value: child.value.slice(offset) });
        }
        return parts;
      });
    };
    visit(tree);
  };
}
