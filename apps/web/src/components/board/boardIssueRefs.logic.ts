import type {
  BoardColumn,
  BoardIssue,
  BoardWorkflowState,
  ComposerContextId,
  RepositoryIdentity,
  TeamCatalogEntry,
} from "@t3tools/contracts";
import { teamCatalogRepositoryMatches } from "@t3tools/contracts";
import { formatComposerContextHref } from "@t3tools/shared/composerContextReferences";
import type { PhrasingContent, Root, RootContent } from "mdast";

/** The context kind an issue id in prose renders through `renderContextReference`. */
export const BOARD_ISSUE_REF_KIND = "linear-issue";

// An id the way prose mentions it: `COD-60`, `(COD-60)` or `COD-60,`, but not `a/COD-60`,
// `COD-60a`, `COD-60-x` or `COD-0`. Team keys follow the catalog's `linear.team` pattern.
const ISSUE_REF =
  /(?<![\p{L}\p{N}_/-])[A-Z][A-Z0-9_]{0,15}-[1-9][0-9]{0,7}(?![\p{L}\p{N}_]|-[\p{L}\p{N}])/gu;
const LINEAR_ISSUE_PATH = /^\/[^/]+\/issue\/([A-Za-z][A-Za-z0-9_]{0,15}-[1-9][0-9]{0,7})(?:\/|$)/;

export function issueTeamKey(identifier: string): string {
  return identifier.slice(0, identifier.lastIndexOf("-"));
}

/** The issue ids `text` mentions, in order. */
export function findIssueRefs(
  text: string,
): ReadonlyArray<{ readonly identifier: string; readonly start: number; readonly end: number }> {
  return Array.from(text.matchAll(ISSUE_REF), (match) => ({
    identifier: match[0],
    start: match.index,
    end: match.index + match[0].length,
  }));
}

/** The identifier in a Linear issue URL, such as `https://linear.app/acme/issue/COD-60/slug`. */
export function parseLinearIssueUrl(href: string): string | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.hostname !== "linear.app") return null;
  return LINEAR_ISSUE_PATH.exec(url.pathname)?.[1]?.toUpperCase() ?? null;
}

/** The Linear team whose issues the project's board shows, when the catalog names one. */
export function boardTeamKey(input: {
  readonly catalogProjects: ReadonlyArray<TeamCatalogEntry>;
  readonly repositoryIdentity: RepositoryIdentity | null | undefined;
}): string | null {
  const entry = input.catalogProjects.find((candidate) =>
    teamCatalogRepositoryMatches(candidate.project.repo, input.repositoryIdentity),
  );
  return entry?.project.linear?.team ?? null;
}

export interface BoardIssueOpenTarget {
  readonly identifier: string;
  /** The clicked Linear link; null for an id written without one. */
  readonly linearUrl: string | null;
}

/**
 * What a click on a Linear issue link opens in the Board: an issue of the board's team. Null leaves
 * the click to open Linear as any link does; a modified click always does.
 */
export function boardIssueOpenTarget(input: {
  readonly href: string;
  readonly boardTeamKey: string | null;
  readonly modified: boolean;
}): BoardIssueOpenTarget | null {
  if (input.boardTeamKey === null || input.modified) return null;
  const identifier = parseLinearIssueUrl(input.href);
  if (identifier === null || issueTeamKey(identifier) !== input.boardTeamKey) return null;
  return { identifier, linearUrl: input.href };
}

/** The issue on the board by its id or its identifier, with its column's state. */
export function findBoardIssue(
  columns: ReadonlyArray<BoardColumn>,
  issue: string,
): { readonly issue: BoardIssue; readonly state: BoardWorkflowState } | null {
  for (const column of columns) {
    const found = column.issues.find((entry) => entry.id === issue || entry.identifier === issue);
    if (found !== undefined) return { issue: found, state: column.state };
  }
  return null;
}

/** A Linear URL for an issue of the board's workspace, built from any issue the board shows. */
export function boardLinearIssueUrl(
  columns: ReadonlyArray<BoardColumn>,
  identifier: string,
): string | null {
  for (const column of columns) {
    for (const issue of column.issues) {
      const match = /^(https:\/\/linear\.app\/[^/]+\/issue\/)/.exec(issue.url);
      if (match !== null) return `${match[1]}${identifier}`;
    }
  }
  return null;
}

/**
 * Turns each issue id in prose into a `t3-context` link that `renderContextReference` renders.
 * Code is not text, so it keeps its ids, and existing links are left alone.
 */
export function remarkBoardIssueRefs() {
  return (tree: Root) => {
    const visit = (node: Root | RootContent) => {
      if (!("children" in node) || node.type === "link" || node.type === "linkReference") return;
      node.children = node.children.flatMap((child): typeof node.children => {
        if (child.type !== "text") {
          visit(child);
          return [child];
        }
        const refs = findIssueRefs(child.value);
        if (refs.length === 0) return [child];
        const parts: PhrasingContent[] = [];
        let offset = 0;
        for (const { identifier, start, end } of refs) {
          if (start > offset) parts.push({ type: "text", value: child.value.slice(offset, start) });
          parts.push({
            type: "link",
            url: formatComposerContextHref(BOARD_ISSUE_REF_KIND, identifier as ComposerContextId),
            children: [{ type: "text", value: identifier }],
          });
          offset = end;
        }
        if (offset < child.value.length)
          parts.push({ type: "text", value: child.value.slice(offset) });
        return parts;
      });
    };
    visit(tree);
  };
}
