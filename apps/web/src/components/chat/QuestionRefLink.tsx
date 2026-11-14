import { parseScopedThreadKey, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { AssistantCitation, MessageId, ScopedThreadRef } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { Link, useNavigate } from "@tanstack/react-router";
import { Atom } from "effect/reactivity";
import { createContext, use, type ReactNode } from "react";

import {
  assistantCitationNavigation,
  assistantCitationRoute,
} from "~/lib/assistantCitationNavigation";
import { useQuietThreadShell } from "~/state/entities";
import { environmentThreadDetails } from "../../state/threads";
import type { ChatMarkdownContextReference } from "../ChatMarkdown";
import {
  findQuestionRefs,
  latestQuestionCards,
  QUESTION_REF_KIND,
  remarkQuestionRefs,
  sameQuestionCardTargets,
  type QuestionCardTarget,
} from "./questionBlock.logic";

type QuestionCards = ReadonlyMap<string, QuestionCardTarget<MessageId>>;

const NO_QUESTION_CARDS: QuestionCards = new Map();
const NO_QUESTION_CARDS_ATOM = Atom.make(NO_QUESTION_CARDS);

// One derivation per thread, shared by every message; it holds while the cards stay the same.
const questionCardsAtomFamily = Atom.family((key: string) => {
  const threadRef = parseScopedThreadKey(key);
  let previous = NO_QUESTION_CARDS;
  return Atom.make((get) => {
    if (threadRef === null) return NO_QUESTION_CARDS;
    const next = latestQuestionCards(
      get(environmentThreadDetails.timelineVisibleTurnItemsAtom(threadRef)),
    );
    if (!sameQuestionCardTargets(previous, next)) previous = next;
    return previous;
  }).pipe(Atom.setIdleTTL(0));
});

export const QuestionRefScope = createContext<{
  readonly threadRef: ScopedThreadRef;
  readonly cards: QuestionCards;
} | null>(null);

// Module constants: the plugin list keys ChatMarkdown's shared parse cache.
const QUESTION_REF_REMARK_PLUGINS = [remarkQuestionRefs];

function renderQuestionRef(reference: ChatMarkdownContextReference): ReactNode {
  if (reference.kind !== QUESTION_REF_KIND) return <span>{reference.label}</span>;
  return <QuestionRef id={reference.contextId} />;
}

/**
 * Links question ids an assistant message mentions to their cards, where cards render. Only a
 * finished message that mentions a known id parses with the extra plugin; streaming keeps the
 * block-by-block parse.
 */
export function useQuestionRefs({
  threadRef,
  askedInItemId,
  text,
  streaming,
}: {
  readonly threadRef: ScopedThreadRef | undefined;
  readonly askedInItemId: string | undefined;
  readonly text: string;
  readonly streaming: boolean;
}) {
  const cards = useAtomValue(
    threadRef && askedInItemId !== undefined
      ? questionCardsAtomFamily(scopedThreadKey(threadRef))
      : NO_QUESTION_CARDS_ATOM,
  );
  const active =
    threadRef !== undefined &&
    !streaming &&
    cards.size > 0 &&
    findQuestionRefs(text).some((ref) => cards.has(ref.id));
  return {
    scope: active ? { threadRef, cards } : null,
    markdownProps: active
      ? {
          extraRemarkPlugins: QUESTION_REF_REMARK_PLUGINS,
          renderContextReference: renderQuestionRef,
        }
      : {},
  };
}

function QuestionRef({ id }: { readonly id: string }) {
  const scope = use(QuestionRefScope);
  const target = scope?.cards.get(id);
  if (!scope || !target) return id;
  return <QuestionCardLink id={id} threadRef={scope.threadRef} target={target} />;
}

/** Opens the card the way a response citation opens its source: scroll, then pulse its prompt. */
function QuestionCardLink({
  id,
  threadRef,
  target,
}: {
  readonly id: string;
  readonly threadRef: ScopedThreadRef;
  readonly target: QuestionCardTarget<MessageId>;
}) {
  const navigate = useNavigate();
  const sourceThread = useQuietThreadShell(threadRef);
  // The card renders its id right before its prompt, so the id pins the prompt to this card.
  const citation: AssistantCitation = {
    version: 1,
    environmentId: threadRef.environmentId,
    threadId: threadRef.threadId,
    messageId: target.messageId,
    text: target.prompt,
    start: 0,
    end: target.prompt.length,
    prefix: id,
    suffix: "",
  };
  return (
    <Link
      {...assistantCitationRoute(citation, sourceThread)}
      data-markdown-copy={id}
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
      {id}
    </Link>
  );
}
