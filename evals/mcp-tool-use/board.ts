/**
 * A thread whose project is on a Linear board: T3's `<board>` block from source, and a stand-in
 * for Linear's MCP server. Cases answer its tools with `mocks` by bare name, such as `save_issue`.
 */
import type { EnvironmentId, TeamCatalogLinear } from "@t3tools/contracts";
import { THREAD_LINK_PROTOCOL } from "@t3tools/shared/threadLinks";

import { boardInstructions } from "../../apps/server/src/memory/Memory.ts";

/** Claude Code's name prefix for tools from an MCP server called `linear`. */
export const LINEAR_PREFIX = "mcp__linear__";

/** The text T3 gives a Claude thread in a project on `board`. */
export const boardMemory = (board: TeamCatalogLinear, environmentId: EnvironmentId) =>
  boardInstructions(board, `${THREAD_LINK_PROTOCOL}://v2/${environmentId}/mcp-tool-use-eval`);

const string = (description: string) => ({ type: "string", description });
const tool = (
  name: string,
  description: string,
  properties: Readonly<Record<string, unknown>>,
  required: ReadonlyArray<string> = [],
) => ({
  name: `${LINEAR_PREFIX}${name}`,
  description,
  input_schema: { type: "object", properties, required },
});

/** The Linear tools an agent uses to find, file and update an issue, after Linear's own server. */
export const linearTools = [
  tool("list_issues", "List issues in the workspace, filtered by team, status, assignee or text.", {
    team: string("Team name or key"),
    query: string("Text to search titles and descriptions for"),
    state: string("Status name"),
    assignee: string('User name, email or "me"'),
  }),
  tool(
    "get_issue",
    "Get an issue by its identifier, such as LIN-123.",
    { id: string("Issue id") },
    ["id"],
  ),
  tool(
    "save_issue",
    "Create or update an issue. Omit id to create one; team is required when creating.",
    {
      id: string("Issue id, to update an existing issue"),
      team: string("Team name or key"),
      title: string("Issue title"),
      description: string("Markdown description"),
      assignee: string('User name, email or "me"'),
      state: string("Status name, such as In Progress"),
    },
  ),
  tool(
    "create_attachment",
    "Attach a link to an issue.",
    { issue: string("Issue id"), url: string("Link URL"), title: string("Link title") },
    ["issue", "url"],
  ),
  tool(
    "save_comment",
    "Create or update a comment on an issue.",
    { issueId: string("Issue id"), body: string("Markdown comment") },
    ["issueId", "body"],
  ),
];
