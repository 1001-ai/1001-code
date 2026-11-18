import type { LegendListRef } from "@legendapp/list/react";
import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { parseScopedThreadKey, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import type { AssistantCitation, MessageId, ScopedThreadRef } from "@t3tools/contracts";
import { findBackReferences } from "@t3tools/shared/backReferences";
import { Link, useNavigate } from "@tanstack/react-router";
import { Atom, type AtomRegistry } from "effect/reactivity";
import {
  createContext,
  use,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import type { PluggableList } from "unified";

import {
  assistantCitationNavigation,
  assistantCitationRoute,
} from "~/lib/assistantCitationNavigation";
import { resolveAssistantCitationRange } from "~/lib/assistantTextSelection";
import {
  BACK_REFERENCE_NOT_FOUND,
  backReferenceCitation,
  isBackReferenceCitation,
} from "~/lib/backReferenceCitation";
import { useQuietThreadShell } from "~/state/entities";
import { environmentThreadDetails, threadEnvironment } from "../../state/threads";
import { toastManager } from "../ui/toast";
import type { ChatMarkdownContextReference } from "../ChatMarkdown";
import {
  observeAssistantCitationSource,
  type AssistantCitationTarget,
} from "./AssistantCitationSource";
import {
  BACK_REFERENCE_KIND,
  backReferenceSources,
  findBackReferenceTarget,
  remarkBackReferences,
  sameBackReferenceSources,
  searchBackReferenceHistory,
  type BackReferenceSource,
  type BackReferenceTarget,
} from "./backReferences.logic";

type Sources = ReadonlyArray<BackReferenceSource<MessageId>>;

const NO_SOURCES: Sources = [];
const NO_SOURCES_ATOM = Atom.make(NO_SOURCES);

// One derivation per thread, shared by every message that has a marker; it holds while the
// finished messages stay the same.
const backReferenceSourcesAtomFamily = Atom.family((key: string) => {
  const threadRef = parseScopedThreadKey(key);
  let previous = NO_SOURCES;
  return Atom.make((get) => {
    if (threadRef === null) return NO_SOURCES;
    const next = backReferenceSources(
      get(environmentThreadDetails.timelineVisibleTurnItemsAtom(threadRef)),
    );
    if (!sameBackReferenceSources(previous, next)) previous = next;
    return previous;
  }).pipe(Atom.setIdleTTL(0));
});

const NO_HISTORY_ATOM = Atom.make({ hasMoreHistory: false });

/** A marker's target, or `earlier` when no loaded message holds its words but older ones may. */
type MarkerTarget = BackReferenceTarget<MessageId> | "earlier";

export const BackReferenceScope = createContext<{
  readonly threadRef: ScopedThreadRef;
  readonly itemId: string;
  readonly targets: ReadonlyMap<string, MarkerTarget>;
} | null>(null);

type RenderContextReference = (reference: ChatMarkdownContextReference) => ReactNode;

// Module constants: the plugin list keys ChatMarkdown's shared parse cache.
const BACK_REFERENCE_REMARK_PLUGINS: PluggableList = [remarkBackReferences];
const pluginsAfter = new WeakMap<PluggableList, PluggableList>();
const rendererAfter = new WeakMap<RenderContextReference, RenderContextReference>();

function renderBackReferenceOr(
  fallback: RenderContextReference | undefined,
): RenderContextReference {
  return (reference) =>
    reference.kind === BACK_REFERENCE_KIND ? (
      <BackReference label={reference.label} />
    ) : fallback ? (
      fallback(reference)
    ) : (
      <span>{reference.label}</span>
    );
}
const renderBackReference = renderBackReferenceOr(undefined);

/**
 * Links the `(↑ "words")` markers of a finished assistant message to the earlier message holding
 * those words. A marker whose words match no earlier message stays text, and a message without
 * one parses as before. Adds to the markdown props of other mentions, such as question ids.
 */
export function useBackReferences<
  Props extends {
    readonly extraRemarkPlugins?: PluggableList;
    readonly renderContextReference?: RenderContextReference;
  },
>({
  threadRef,
  itemId,
  text,
  streaming,
  markdownProps,
}: {
  readonly threadRef: ScopedThreadRef | undefined;
  readonly itemId: string | undefined;
  readonly text: string;
  readonly streaming: boolean;
  readonly markdownProps: Props;
}) {
  const references =
    threadRef !== undefined && itemId !== undefined && !streaming ? findBackReferences(text) : [];
  const active = threadRef !== undefined && references.length > 0;
  const sources = useAtomValue(
    active ? backReferenceSourcesAtomFamily(scopedThreadKey(threadRef)) : NO_SOURCES_ATOM,
  );
  const { hasMoreHistory } = useAtomValue(
    active ? environmentThreadDetails.historyAtom(threadRef) : NO_HISTORY_ATOM,
  );
  const targets = new Map<string, MarkerTarget>();
  for (const { excerpt } of references) {
    if (targets.has(excerpt)) continue;
    const target = findBackReferenceTarget(sources, itemId!, excerpt);
    if (target !== null) targets.set(excerpt, target);
    else if (hasMoreHistory) targets.set(excerpt, "earlier");
  }
  if (threadRef === undefined || itemId === undefined || targets.size === 0) {
    return { scope: null, markdownProps };
  }
  const { extraRemarkPlugins: plugins, renderContextReference: render } = markdownProps;
  let extraRemarkPlugins = BACK_REFERENCE_REMARK_PLUGINS;
  if (plugins !== undefined && plugins.length > 0) {
    extraRemarkPlugins = pluginsAfter.get(plugins) ?? [...plugins, remarkBackReferences];
    pluginsAfter.set(plugins, extraRemarkPlugins);
  }
  let renderContextReference = renderBackReference;
  if (render !== undefined) {
    renderContextReference = rendererAfter.get(render) ?? renderBackReferenceOr(render);
    rendererAfter.set(render, renderContextReference);
  }
  return {
    scope: { threadRef, itemId, targets },
    markdownProps: { ...markdownProps, extraRemarkPlugins, renderContextReference },
  };
}

function BackReference({ label }: { readonly label: string }) {
  const scope = use(BackReferenceScope);
  const excerpt = findBackReferences(label)[0]?.excerpt;
  const target = excerpt === undefined ? undefined : scope?.targets.get(excerpt);
  if (!scope || excerpt === undefined || !target) return label;
  return (
    <BackReferenceLink
      label={label}
      excerpt={excerpt}
      itemId={scope.itemId}
      threadRef={scope.threadRef}
      target={target}
    />
  );
}

/** Resolves once the thread has no history page loading. */
function settledHistory(
  registry: AtomRegistry.AtomRegistry,
  threadRef: ScopedThreadRef,
): Promise<{ readonly hasMoreHistory: boolean }> {
  const atom = environmentThreadDetails.historyAtom(threadRef);
  return new Promise((resolve) => {
    let unsubscribe: (() => void) | undefined;
    let done = false;
    const check = (history: Atom.Type<typeof atom>) => {
      if (done || history.loading) return;
      done = true;
      unsubscribe?.();
      resolve(history);
    };
    unsubscribe = registry.subscribe(atom, check);
    if (done) unsubscribe();
    else check(registry.get(atom));
  });
}

/**
 * Opens the earlier message the way a response citation opens its source: scroll, then pulse.
 * The click finds the target again, paging older history in when no loaded message holds it.
 */
function BackReferenceLink({
  label,
  excerpt,
  itemId,
  threadRef,
  target,
}: {
  readonly label: string;
  readonly excerpt: string;
  readonly itemId: string;
  readonly threadRef: ScopedThreadRef;
  readonly target: MarkerTarget;
}) {
  const navigate = useNavigate();
  const registry = use(RegistryContext);
  const sourceThread = useQuietThreadShell(threadRef);
  const route =
    target === "earlier"
      ? {
          to: "/$environmentId/$threadId" as const,
          params: { environmentId: threadRef.environmentId, threadId: threadRef.threadId },
        }
      : assistantCitationRoute(
          backReferenceCitation(threadRef, target.messageId, excerpt),
          sourceThread,
        );
  const open = async () => {
    const sourcesAtom = backReferenceSourcesAtomFamily(scopedThreadKey(threadRef));
    const result = await searchBackReferenceHistory({
      find: () => findBackReferenceTarget(registry.get(sourcesAtom), itemId, excerpt),
      readHistory: () => settledHistory(registry, threadRef),
      loadPage: async () => {
        const loaded = await runAtomCommand(
          registry,
          threadEnvironment.loadEarlierHistory,
          { environmentId: threadRef.environmentId, input: { threadId: threadRef.threadId } },
          { label: "load history for a back-reference", reportFailure: false },
        );
        return loaded._tag === "Success" ? loaded.value : { _tag: "error" };
      },
    });
    if (result._tag === "aborted") return;
    if (result._tag === "not-found") {
      toastManager.add({ type: "warning", ...BACK_REFERENCE_NOT_FOUND });
      return;
    }
    void navigate(
      assistantCitationNavigation(
        backReferenceCitation(threadRef, result.target.messageId, excerpt),
        sourceThread,
      ),
    );
  };
  return (
    <Link
      {...route}
      data-markdown-copy={label}
      onClick={(event) => {
        if (
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        ) {
          return;
        }
        event.preventDefault();
        void open();
      }}
    >
      {label}
    </Link>
  );
}

/**
 * Unfolds a folded message when a back-reference reveal targets it, once per activation; the
 * user can fold it again.
 */
export function useUnfoldForBackReference(
  request: AssistantCitationTarget | null,
  messageId: MessageId,
  unfold: () => void,
) {
  const [unfoldedFor, setUnfoldedFor] = useState<string | null>(null);
  const key =
    request !== null &&
    request.citation.messageId === messageId &&
    isBackReferenceCitation(request.citation)
      ? request.key
      : null;
  if (key !== null && key !== unfoldedFor) {
    setUnfoldedFor(key);
    unfold();
  }
}

/**
 * An unfolded agent message scrolls inside its own box, which the list's scroll cannot reach, so
 * the box scrolls the quote into view first.
 */
function scrollInnerScrollersTo(root: HTMLElement, citation: AssistantCitation, outer: unknown) {
  const range = resolveAssistantCitationRange(root, citation);
  if (range === null) return;
  for (let box = root.parentElement; box !== null && box !== outer; box = box.parentElement) {
    if (box.scrollHeight <= box.clientHeight) continue;
    const { overflowY } = getComputedStyle(box);
    if (overflowY !== "auto" && overflowY !== "scroll") continue;
    const rangeRect = range.getBoundingClientRect();
    const boxRect = box.getBoundingClientRect();
    if (rangeRect.top < boxRect.top || rangeRect.bottom > boxRect.bottom) {
      box.scrollTop += rangeRect.top - boxRect.top - box.clientHeight / 3;
    }
  }
}

/**
 * Reveals a back-reference's words in a user message the way `AssistantCitationSource` does in a
 * response, without marking the message as a citation source, so selecting its text still offers
 * no citation.
 */
export function BackReferenceUserSource({
  messageId,
  itemKey,
  request,
  listRef,
  children,
}: {
  readonly messageId: MessageId;
  readonly itemKey: string;
  readonly request: AssistantCitationTarget | null;
  readonly listRef: RefObject<LegendListRef | null>;
  readonly children: ReactNode;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- observes this message's DOM for a back-reference reveal request and scrolls the LegendList to it
  useEffect(() => {
    const root = rootRef.current;
    const list = listRef.current;
    if (!root || !list || !request || request.citation.messageId !== messageId) return;
    // A long message folds under "Show full message"; find's reveal event opens it.
    for (const fold of root.querySelectorAll("[data-thread-find-fold]")) {
      fold.dispatchEvent(new Event("beforematch"));
    }
    scrollInnerScrollersTo(root, request.citation, list.getScrollableNode());
    return observeAssistantCitationSource({ root, itemKey, request, list });
  }, [itemKey, listRef, messageId, request]);
  return <div ref={rootRef}>{children}</div>;
}
