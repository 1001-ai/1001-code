import { useAtomValue } from "@effect/atom-react";
import { parseScopedThreadKey, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { createContext, type MouseEvent, type ReactNode, use } from "react";
import type { PluggableList } from "unified";

import { useRightPanelStore } from "~/rightPanelStore";
import { boardConnectionAtom } from "~/state/board";
import { environmentProjects } from "~/state/projects";
import { teamCatalogAtom } from "~/state/teamCatalog";
import { environmentThreadShells } from "~/state/threads";
import type { ChatMarkdownContextReference } from "../ChatMarkdown";
import {
  BOARD_ISSUE_REF_KIND,
  type BoardIssueOpenTarget,
  boardIssueOpenTarget,
  boardTeamKey,
  findIssueRefs,
  issueTeamKey,
  remarkBoardIssueRefs,
} from "./boardIssueRefs.logic";
import { useBoardOpenIssueStore } from "./boardOpenIssueStore";

const NO_TEAM_KEY_ATOM = Atom.make<string | null>(null);

// One derivation per thread, shared by every message. It yields a string, so a message re-renders
// only when the team changes, and it never subscribes to the board, which would poll Linear.
const boardTeamKeyAtomFamily = Atom.family((key: string) => {
  const threadRef = parseScopedThreadKey(key);
  return Atom.make((get): string | null => {
    if (threadRef === null) return null;
    const { environmentId } = threadRef;
    const connection = AsyncResult.getOrElse(get(boardConnectionAtom(environmentId)), () => null);
    if (connection?.status !== "connected") return null;
    const projectId = get(environmentThreadShells.threadShellAtom(threadRef))?.projectId;
    if (projectId === undefined) return null;
    const project = get(environmentProjects.projectAtom({ environmentId, projectId }));
    const catalog = AsyncResult.getOrElse(get(teamCatalogAtom(environmentId)), () => null);
    return boardTeamKey({
      catalogProjects: catalog?.projects ?? [],
      repositoryIdentity: project?.repositoryIdentity,
    });
  }).pipe(Atom.setIdleTTL(0), Atom.withLabel(`web-board-team-key:${key}`));
});

/** The Linear team the thread's Board shows; null while signed out or without a board. */
export function useBoardTeamKey(threadRef: ScopedThreadRef | undefined): string | null {
  return useAtomValue(
    threadRef === undefined ? NO_TEAM_KEY_ATOM : boardTeamKeyAtomFamily(scopedThreadKey(threadRef)),
  );
}

/** Shows the issue in the thread's Board, which says so when the issue is not on it. */
function openBoardIssue(threadRef: ScopedThreadRef, target: BoardIssueOpenTarget) {
  useBoardOpenIssueStore.getState().setOpenIssue(scopedThreadKey(threadRef), {
    issue: target.identifier,
    fromOutside: true,
    linearUrl: target.linearUrl,
  });
  useRightPanelStore.getState().open(threadRef, "board");
}

type IssueLinkClick = Pick<
  MouseEvent<HTMLElement>,
  "preventDefault" | "stopPropagation" | "metaKey" | "ctrlKey"
> &
  Partial<Pick<MouseEvent<HTMLElement>, "button" | "shiftKey" | "altKey">>;

/**
 * Opens a clicked Linear issue link in the thread's Board when the Board shows that issue's team,
 * and returns true. Otherwise, or on a modified click, returns false: open Linear as before.
 */
export function useOpenBoardIssueLink(threadRef: ScopedThreadRef | undefined) {
  const teamKey = useBoardTeamKey(threadRef);
  return (event: IssueLinkClick, href: string): boolean => {
    if (threadRef === undefined) return false;
    const target = boardIssueOpenTarget({
      href,
      boardTeamKey: teamKey,
      modified:
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey === true ||
        event.altKey === true ||
        (event.button ?? 0) !== 0,
    });
    if (target === null) return false;
    event.preventDefault();
    event.stopPropagation();
    openBoardIssue(threadRef, target);
    return true;
  };
}

/** Tries the Board before ChatMarkdown's change request handling, which takes the same call. */
export function boardIssueLinksFirst<Rest extends ReadonlyArray<unknown>>(
  openBoardIssueLink: (event: IssueLinkClick, href: string) => boolean,
  openChangeRequestLink: (event: IssueLinkClick, href: string, ...rest: Rest) => boolean,
) {
  return (event: IssueLinkClick, href: string, ...rest: Rest): boolean =>
    openBoardIssueLink(event, href) || openChangeRequestLink(event, href, ...rest);
}

export const BoardIssueRefScope = createContext<{
  readonly threadRef: ScopedThreadRef;
  readonly teamKey: string;
} | null>(null);

// Module constants: the plugin list keys ChatMarkdown's shared parse cache.
const ISSUE_REF_REMARK_PLUGINS: PluggableList = [remarkBoardIssueRefs];
const issueRefPluginsAfter = new WeakMap<PluggableList, PluggableList>();
type RenderContextReference = (reference: ChatMarkdownContextReference) => ReactNode;
const issueRefRendererAfter = new WeakMap<RenderContextReference, RenderContextReference>();

function renderIssueRefOr(fallback: RenderContextReference | undefined): RenderContextReference {
  return (reference) =>
    reference.kind === BOARD_ISSUE_REF_KIND ? (
      <BoardIssueRef identifier={reference.contextId} />
    ) : fallback ? (
      fallback(reference)
    ) : (
      <span>{reference.label}</span>
    );
}
const renderIssueRef = renderIssueRefOr(undefined);

/**
 * Links issue ids of the Board's team that an assistant message writes without a link. Only a
 * finished message that mentions one parses with the extra plugin; streaming keeps the
 * block-by-block parse. Adds to the markdown props of other mentions, such as question ids.
 */
export function useBoardIssueRefs<
  Props extends {
    readonly extraRemarkPlugins?: PluggableList;
    readonly renderContextReference?: RenderContextReference;
  },
>({
  threadRef,
  text,
  streaming,
  markdownProps,
}: {
  readonly threadRef: ScopedThreadRef | undefined;
  readonly text: string;
  readonly streaming: boolean;
  readonly markdownProps: Props;
}) {
  const teamKey = useBoardTeamKey(threadRef);
  const active =
    threadRef !== undefined &&
    teamKey !== null &&
    !streaming &&
    findIssueRefs(text).some((ref) => issueTeamKey(ref.identifier) === teamKey);
  if (!active) return { scope: null, markdownProps };
  const { extraRemarkPlugins: plugins, renderContextReference: render } = markdownProps;
  let extraRemarkPlugins = ISSUE_REF_REMARK_PLUGINS;
  if (plugins !== undefined && plugins.length > 0) {
    extraRemarkPlugins = issueRefPluginsAfter.get(plugins) ?? [...plugins, remarkBoardIssueRefs];
    issueRefPluginsAfter.set(plugins, extraRemarkPlugins);
  }
  let renderContextReference = renderIssueRef;
  if (render !== undefined) {
    renderContextReference = issueRefRendererAfter.get(render) ?? renderIssueRefOr(render);
    issueRefRendererAfter.set(render, renderContextReference);
  }
  return {
    scope: { threadRef, teamKey },
    markdownProps: { ...markdownProps, extraRemarkPlugins, renderContextReference },
  };
}

function BoardIssueRef({ identifier }: { readonly identifier: string }) {
  const scope = use(BoardIssueRefScope);
  if (!scope || issueTeamKey(identifier) !== scope.teamKey) return identifier;
  const open = () => openBoardIssue(scope.threadRef, { identifier, linearUrl: null });
  return (
    // No href: an id written without a link has no Linear URL here, and Enter opens it.
    <a
      role="link"
      tabIndex={0}
      className="cursor-pointer"
      data-markdown-copy={identifier}
      onClick={(event) => {
        event.preventDefault();
        open();
      }}
      onKeyDown={(event) => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        open();
      }}
    >
      {identifier}
    </a>
  );
}
