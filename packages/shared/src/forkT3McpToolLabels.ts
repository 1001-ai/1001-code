import type { T3McpToolDefinition } from "./t3McpToolPresentation.ts";

/**
 * The fork's wording for thread tools' activity rows: "Sending to a thread", not "a T3 thread".
 * `t3_thread_read` keeps upstream's object, which the timeline matches to show the thread's title.
 */
const FORK_THREAD_TOOL_OBJECTS: Readonly<Record<string, string>> = {
  create_threads: "threads",
  t3_thread_start: "a thread",
  t3_thread_list: "threads",
  t3_thread_send: "to a thread",
  t3_thread_wait: "for a thread",
  t3_thread_interrupt: "a thread",
  t3_thread_update: "thread metadata",
};

export function withForkT3McpToolLabels(
  tools: Readonly<Record<string, T3McpToolDefinition>>,
): Readonly<Record<string, T3McpToolDefinition>> {
  const relabeled = { ...tools };
  for (const [name, object] of Object.entries(FORK_THREAD_TOOL_OBJECTS)) {
    const definition = tools[name];
    if (definition === undefined) continue;
    const [action, running, completed] = definition.labels;
    relabeled[name] = {
      ...definition,
      displayName: `${action} ${object}`,
      labels: [action, running, completed, object],
    };
  }
  return relabeled;
}
