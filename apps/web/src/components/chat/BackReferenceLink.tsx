import type { LegendListRef } from "@legendapp/list/react";
import { useAtomValue } from "@effect/atom-react";
import { parseScopedThreadKey, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { AssistantCitation, MessageId, ScopedThreadRef } from "@t3tools/contracts";
import { findBackReferences } from "@t3tools/shared/backReferences";
import { Link, useNavigate } from "@tanstack/react-router";
import { Atom } from "effect/reactivity";
import { createContext, use, useEffect, useRef, type ReactNode, type RefObject } from "react";
import type { PluggableList } from "unified";

import {
  assistantCitationNavigation,
  assistantCitationRoute,
} from "~/lib/assistantCitationNavigation";
import { useQuietThreadShell } from "~/state/entities";
import { environmentThreadDetails } from "../../state/threads";
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

export const BackReferenceScope = createContext<{
  readonly threadRef: ScopedThreadRef;
  readonly targets: ReadonlyMap<string, BackReferenceTarget<MessageId>>;
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
  const sources = useAtomValue(
    threadRef && references.length > 0
      ? backReferenceSourcesAtomFamily(scopedThreadKey(threadRef))
      : NO_SOURCES_ATOM,
  );
  const targets = new Map<string, BackReferenceTarget<MessageId>>();
  for (const { excerpt } of references) {
    if (targets.has(excerpt)) continue;
    const target = findBackReferenceTarget(sources, itemId!, excerpt);
    if (target !== null) targets.set(excerpt, target);
  }
  if (threadRef === undefined || targets.size === 0) return { scope: null, markdownProps };
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
    scope: { threadRef, targets },
    markdownProps: { ...markdownProps, extraRemarkPlugins, renderContextReference },
  };
}

function BackReference({ label }: { readonly label: string }) {
  const scope = use(BackReferenceScope);
  const excerpt = findBackReferences(label)[0]?.excerpt;
  const target = excerpt === undefined ? undefined : scope?.targets.get(excerpt);
  if (!scope || !target) return label;
  return <BackReferenceLink label={label} threadRef={scope.threadRef} target={target} />;
}

/** Opens the earlier message the way a response citation opens its source: scroll, then pulse. */
function BackReferenceLink({
  label,
  threadRef,
  target,
}: {
  readonly label: string;
  readonly threadRef: ScopedThreadRef;
  readonly target: BackReferenceTarget<MessageId>;
}) {
  const navigate = useNavigate();
  const sourceThread = useQuietThreadShell(threadRef);
  const citation: AssistantCitation = {
    version: 1,
    environmentId: threadRef.environmentId,
    threadId: threadRef.threadId,
    messageId: target.messageId,
    text: target.text,
    start: 0,
    end: target.text.length,
    prefix: "",
    suffix: "",
  };
  return (
    <Link
      {...assistantCitationRoute(citation, sourceThread)}
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
        void navigate(assistantCitationNavigation(citation, sourceThread));
      }}
    >
      {label}
    </Link>
  );
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
    return observeAssistantCitationSource({ root, itemKey, request, list });
  }, [itemKey, listRef, messageId, request]);
  return <div ref={rootRef}>{children}</div>;
}
