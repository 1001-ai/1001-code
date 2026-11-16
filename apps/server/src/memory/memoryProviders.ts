import type { OrchestrationV2AppThreadLineage, ProjectId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { CODEX_ADDITIONAL_CONTEXT_VALUE_MAX_BYTES } from "../provider/CodexDeveloperInstructions.ts";
import type { Memory } from "./Memory.ts";

/**
 * The turn input's `memory` field, absent where the server runs without the service. The voice
 * agent's thread gets the person's voice agent memories and nothing else: the project's memory
 * is written for agents that work in the repository.
 */
export const memoryTurnInput = (
  service: Option.Option<Memory["Service"]>,
  projectId: ProjectId,
  threadId: ThreadId,
  lineage?: OrchestrationV2AppThreadLineage,
): Effect.Effect<{ readonly memory?: string }> =>
  Option.isNone(service)
    ? Effect.succeed({})
    : (lineage?.voiceAgent === true
        ? service.value.voiceAgentInstructions()
        : service.value.instructions(projectId, threadId)
      ).pipe(Effect.map((block) => (block === undefined ? {} : { memory: block })));

const encoder = new TextEncoder();

/** The block as Codex `additionalContext` entries, split on lines to fit Codex's per-entry cap. */
export function codexMemoryContext(
  block: string | undefined,
): Record<string, { readonly kind: "application"; readonly value: string }> {
  if (block === undefined) return {};
  const chunks: Array<string> = [];
  let current = "";
  for (const line of block.split("\n")) {
    const next = current === "" ? line : `${current}\n${line}`;
    if (encoder.encode(next).length <= CODEX_ADDITIONAL_CONTEXT_VALUE_MAX_BYTES) {
      current = next;
      continue;
    }
    if (current !== "") chunks.push(current);
    current = line;
    // A single line over the cap is split between characters.
    if (encoder.encode(current).length > CODEX_ADDITIONAL_CONTEXT_VALUE_MAX_BYTES) {
      let piece = "";
      let pieceBytes = 0;
      for (const char of current) {
        const bytes = encoder.encode(char).length;
        if (pieceBytes + bytes > CODEX_ADDITIONAL_CONTEXT_VALUE_MAX_BYTES) {
          chunks.push(piece);
          piece = "";
          pieceBytes = 0;
        }
        piece += char;
        pieceBytes += bytes;
      }
      current = piece;
    }
  }
  if (current !== "") chunks.push(current);
  return Object.fromEntries(
    chunks.map((value, index) => [
      `t3_memory_${String(index + 1).padStart(2, "0")}`,
      { kind: "application" as const, value },
    ]),
  );
}

const MEMORY_KEY_SEPARATOR = "\u0000memory:";

/**
 * Claude reads its system prompt once per process, so the live query's key carries the block: a
 * changed block reopens the process with resume at the next turn. While the process still runs
 * background work the old key is kept, so a merged memory never ends that work or fails the
 * turn; the change arrives at a later reopen.
 */
export const claudeMemoryQueryKey = Effect.fnUntraced(function* <
  Live extends { readonly queryPolicyKey: string },
>(
  policyKey: string,
  block: string | undefined,
  existing: Live | null,
  runsBackgroundWork: (live: Live) => Effect.Effect<boolean>,
) {
  const key = `${policyKey}${MEMORY_KEY_SEPARATOR}${block ?? ""}`;
  if (
    existing !== null &&
    existing.queryPolicyKey !== key &&
    existing.queryPolicyKey.startsWith(`${policyKey}${MEMORY_KEY_SEPARATOR}`) &&
    (yield* runsBackgroundWork(existing))
  ) {
    return existing.queryPolicyKey;
  }
  return key;
});
