import { describe, expect, it } from "@effect/vitest";

import { agentsBoardAgentCommand } from "./agentsBoard.ts";

describe("agentsBoardAgentCommand", () => {
  it.each([
    [undefined, "git fetch origin agent-reports && git show origin/agent-reports:README.md"],
    // Another repository is not `origin` in a checkout of the project, so it is named by URL.
    [
      "github.com/acme/widgets-notes",
      "git fetch https://github.com/acme/widgets-notes.git agent-reports && git show FETCH_HEAD:README.md",
    ],
    [
      "git.acme.test:8443/team/tools/notes.git",
      "git fetch https://git.acme.test:8443/team/tools/notes.git agent-reports && git show FETCH_HEAD:README.md",
    ],
  ])("for a board in %s is %s", (repository, expected) => {
    expect(agentsBoardAgentCommand("agent-reports", repository)).toBe(expected);
  });
});
