// @effect-diagnostics nodeBuiltinImport:off -- Executes the shipped Pi extension at its native JavaScript boundary.
import * as NodeModule from "node:module";
import * as NodeVM from "node:vm";
import { assert, describe, it } from "@effect/vitest";
import { QUESTION_CARD_INSTRUCTIONS } from "@t3tools/provider-core/server/runtimeInstructions";

import { PI_T3_MCP_EXTENSION_SOURCE } from "./mcpExtensionSource.ts";

type AgentStartHook = (
  event: {
    systemPrompt: string;
    systemPromptOptions?: { sections?: Record<string, string>; forceSystemPrompt?: string };
  },
  ctx: unknown,
) => { systemPrompt: string } | undefined;

async function agentStartHooksWithoutMcp() {
  const hooks: AgentStartHook[] = [];
  const source = NodeModule.stripTypeScriptTypes(
    PI_T3_MCP_EXTENSION_SOURCE.replace(/^import .*;$/gm, "").replace(
      "export default async function",
      "async function",
    ),
  );
  await NodeVM.runInNewContext(`${source}\nt3McpExtension(pi)`, {
    process: { env: {}, argv: [] },
    pi: {
      on: (name: string, handler: AgentStartHook) => {
        if (name === "before_agent_start") hooks.push(handler);
      },
      registerCommand: () => {},
      getCommands: () => [],
    },
  });
  return hooks;
}

describe("Pi question card instructions", () => {
  it("reach the system prompt without the T3 MCP server", async () => {
    const [hook] = await agentStartHooksWithoutMcp();
    assert.isDefined(hook);

    const appended = hook!({ systemPrompt: "base" }, {});
    assert.strictEqual(appended?.systemPrompt, `base\n\n${QUESTION_CARD_INSTRUCTIONS}`);

    const sections: Record<string, string> = {};
    assert.isUndefined(hook!({ systemPrompt: "base", systemPromptOptions: { sections } }, {}));
    assert.strictEqual(sections.t3_code_question_cards, QUESTION_CARD_INSTRUCTIONS);
  });
});
