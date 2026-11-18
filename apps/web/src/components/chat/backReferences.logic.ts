import type { ComposerContextId } from "@t3tools/contracts";
import { findBackReferences } from "@t3tools/shared/backReferences";
import { formatComposerContextHref } from "@t3tools/shared/composerContextReferences";
import { textAfterReLines } from "@t3tools/shared/replyMarkers";
import type { PhrasingContent, Root, RootContent } from "mdast";

import { reLineMatchText } from "./exchangeThread.logic";

/** A finished chat message a back-reference can point at, in timeline order. */
export interface BackReferenceSource<M extends string = string> {
  readonly itemId: string;
  readonly messageId: M;
  /** The text the message renders where the reveal looks for the words. */
  readonly text: string;
}

export interface BackReferenceTarget<M extends string = string> {
  readonly messageId: M;
  /** The quoted words as the earlier message renders them. */
  readonly text: string;
}

interface TurnItemLike<M extends string> {
  readonly item: {
    readonly id: string;
    readonly type: string;
    readonly text?: unknown;
    readonly messageId?: M;
    readonly streaming?: unknown;
  };
}

const sourceByItem = new WeakMap<object, BackReferenceSource | null>();

/** The finished user and assistant messages of a thread's visible items. Reads each item once. */
export function backReferenceSources<M extends string>(
  items: ReadonlyArray<TurnItemLike<M>>,
): ReadonlyArray<BackReferenceSource<M>> {
  const sources: BackReferenceSource<M>[] = [];
  for (const { item } of items) {
    let source = sourceByItem.get(item) as BackReferenceSource<M> | null | undefined;
    if (source === undefined) {
      const { id, type, text, messageId, streaming } = item;
      source =
        (type === "user_message" || (type === "assistant_message" && streaming !== true)) &&
        typeof text === "string" &&
        messageId !== undefined
          ? {
              itemId: id,
              messageId,
              // Re: lines render above the reply, outside the text the reveal searches.
              text: type === "assistant_message" ? textAfterReLines(text) : text,
            }
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

const MATCH_IGNORED_CHAR = /[*_`~>#]/;

/** `reLineMatchText` of `raw`, with each matched character's place in `raw`. */
interface MatchIndex {
  readonly text: string;
  readonly starts: ReadonlyArray<number>;
  readonly ends: ReadonlyArray<number>;
}

function buildMatchIndex(raw: string): MatchIndex {
  let text = "";
  const starts: number[] = [];
  const ends: number[] = [];
  let space = false;
  for (let index = 0; index < raw.length;) {
    const char = String.fromCodePoint(raw.codePointAt(index)!);
    const next = index + char.length;
    if (/\s/.test(char)) {
      space = text.length > 0;
    } else if (!MATCH_IGNORED_CHAR.test(char)) {
      if (space) {
        text += " ";
        starts.push(index);
        ends.push(index);
        space = false;
      }
      const folded = reLineMatchText(char);
      for (let unit = 0; unit < folded.length; unit += 1) {
        starts.push(index);
        ends.push(next);
      }
      text += folded;
    }
    index = next;
  }
  return { text, starts, ends };
}

const matchIndexBySource = new WeakMap<BackReferenceSource, MatchIndex>();

function matchIndexOf(source: BackReferenceSource): MatchIndex {
  let index = matchIndexBySource.get(source);
  if (index === undefined) {
    index = buildMatchIndex(source.text);
    matchIndexBySource.set(source, index);
  }
  return index;
}

const LINE_MARKS = /^[ \t]*(?:>[ \t]*)*(?:#{1,6}[ \t]+)?/gm;
const INLINE_MARKS = /\*+|`+|~~|(?<![\p{L}\p{N}])_+|_+(?![\p{L}\p{N}])/gu;

/** The words of a markdown slice as chat renders them: emphasis, code and line marks dropped. */
export function renderedQuoteText(slice: string): string {
  return slice.replace(LINE_MARKS, "").replace(INLINE_MARKS, "").replace(/\s+/g, " ").trim();
}

/** Where `excerpt` sits in `source`, ignoring case, quote style, markdown marks and spacing. */
export function findQuoteInSource(source: BackReferenceSource, excerpt: string): string | null {
  const needle = reLineMatchText(excerpt);
  if (needle === "") return null;
  const index = matchIndexOf(source);
  const at = index.text.indexOf(needle);
  if (at < 0) return null;
  const slice = source.text.slice(index.starts[at], index.ends[at + needle.length - 1]);
  const rendered = renderedQuoteText(slice);
  return rendered === "" ? null : rendered;
}

/**
 * The earlier message a back-reference in `itemId` points at: the newest message before it that
 * holds the quoted words. Null when the words appear in none, so the marker stays text.
 */
export function findBackReferenceTarget<M extends string>(
  sources: ReadonlyArray<BackReferenceSource<M>>,
  itemId: string,
  excerpt: string,
): BackReferenceTarget<M> | null {
  const position = sources.findIndex((source) => source.itemId === itemId);
  for (let index = position - 1; index >= 0; index -= 1) {
    const source = sources[index]!;
    const text = findQuoteInSource(source, excerpt);
    if (text !== null) return { messageId: source.messageId, text };
  }
  return null;
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
