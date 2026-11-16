import {
  MEMORY_PROPOSE_TOOL_NAME,
  VOICE_AGENT_MEMORY_CATEGORY,
  VOICE_AGENT_MEMORY_MAX_BYTES,
  VOICE_AGENT_MEMORY_TAG,
  type VoiceAgentMemory,
  type VoiceAgentMemoryLogEntry,
} from "@t3tools/contracts";

/**
 * One person's voice agent memories file: a list of the active memories, each `- text (saved
 * <day>)`, then under "## Earlier" a log of the ones a newer memory replaced, each `- text (saved
 * <day>, replaced <day> by: new text)`.
 */
export interface VoiceAgentMemoryFile {
  readonly active: ReadonlyArray<VoiceAgentMemory>;
  /** Newest first. */
  readonly earlier: ReadonlyArray<VoiceAgentMemoryLogEntry>;
}

const TITLE = "# Voice agent memories";
const LOG_HEADING = "## Earlier";
const DAY = String.raw`\d{4}-\d{2}-\d{2}`;
const HEADING = /^#{1,6}(?:\s+|$)/;
const LIST_MARKER = /^(?:[-*+]|\d+[.)])(?:\s+|$)/;
const SAVED = new RegExp(String.raw`^(.*\S)\s+\(saved (${DAY})\)$`);
const REPLACED = new RegExp(
  String.raw`^(.*?\S)\s+\((?:saved (${DAY}), )?replaced (${DAY}) by: (.*)\)$`,
);

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

/** What two spellings of one memory share: no list marker, no saved date, single spaces. */
const memoryKey = (text: string) => {
  const line = oneLine(text).replace(LIST_MARKER, "");
  return SAVED.exec(line)?.[1] ?? line;
};

/**
 * Reads the file as a person may have left it. Every readable line is an active memory, except
 * the lines under the "Earlier" heading and any line that says what replaced it. Never throws.
 */
export function parseVoiceAgentMemories(fileText: string): VoiceAgentMemoryFile {
  const active: Array<VoiceAgentMemory> = [];
  const earlier: Array<VoiceAgentMemoryLogEntry> = [];
  let inLog = false;
  for (const raw of fileText.split(/\r?\n/)) {
    const line = raw.trim();
    if (HEADING.test(line)) {
      if (/^#+\s*earlier\s*$/i.test(line)) inLog = true;
      continue;
    }
    const text = line.replace(LIST_MARKER, "").trim();
    if (text === "") continue;
    const replaced = REPLACED.exec(text);
    if (replaced !== null) {
      earlier.push({
        text: replaced[1]!,
        savedOn: replaced[2] ?? null,
        replacedOn: replaced[3]!,
        replacedBy: replaced[4]!.trim() === "" ? null : replaced[4]!.trim(),
      });
      continue;
    }
    const saved = SAVED.exec(text);
    const memory = { text: saved?.[1] ?? text, savedOn: saved?.[2] ?? null };
    if (inLog) earlier.push({ ...memory, replacedOn: null, replacedBy: null });
    else active.push(memory);
  }
  return { active, earlier };
}

const savedSuffix = (savedOn: string | null) => (savedOn === null ? "" : ` (saved ${savedOn})`);

function renderVoiceAgentMemories(file: VoiceAgentMemoryFile): string {
  const active = file.active.map((memory) => `- ${memory.text}${savedSuffix(memory.savedOn)}`);
  const earlier = file.earlier.map((entry) =>
    entry.replacedOn === null
      ? `- ${entry.text}${savedSuffix(entry.savedOn)}`
      : `- ${entry.text} (${entry.savedOn === null ? "" : `saved ${entry.savedOn}, `}replaced ${entry.replacedOn} by: ${entry.replacedBy ?? ""})`,
  );
  return `${[
    TITLE,
    ...(active.length === 0 ? [] : [active.join("\n")]),
    ...(earlier.length === 0 ? [] : [`${LOG_HEADING}\n\n${earlier.join("\n")}`]),
  ].join("\n\n")}\n`;
}

/**
 * The active memory that now stands for `text`: the one with that text, or the one that took its
 * place, following the log when `text` was itself replaced since.
 */
export function activeVoiceAgentMemory(
  file: VoiceAgentMemoryFile,
  text: string,
): VoiceAgentMemory | null {
  let key = memoryKey(text);
  const seen = new Set<string>();
  while (!seen.has(key)) {
    seen.add(key);
    const active = file.active.find((memory) => memoryKey(memory.text) === key);
    if (active !== undefined) return active;
    const successor = file.earlier.find(
      (entry) => memoryKey(entry.text) === key && entry.replacedBy !== null,
    )?.replacedBy;
    if (successor == null) return null;
    key = memoryKey(successor);
  }
  return null;
}

/**
 * Saves a memory. The active memory it replaces moves to the top of the log with today's date and
 * the new text; a memory with nothing left to replace, or none named, is only added. `changed` is
 * false when the file already says this.
 */
export function supersedeVoiceAgentMemory(
  fileText: string,
  input: {
    readonly text: string;
    /** The text of the memory to replace; null for a new subject. */
    readonly replaces: string | null;
    /** YYYY-MM-DD. */
    readonly today: string;
  },
): { readonly text: string; readonly replaced: string | null; readonly changed: boolean } {
  const file = parseVoiceAgentMemories(fileText);
  const text = memoryKey(input.text);
  const alreadyActive = file.active.some((memory) => memoryKey(memory.text) === text);
  const target = input.replaces === null ? null : activeVoiceAgentMemory(file, input.replaces);
  const replaced = target !== null && memoryKey(target.text) !== text ? target : null;
  if (text === "" || (alreadyActive && replaced === null)) {
    return { text: fileText, replaced: null, changed: false };
  }
  const next: VoiceAgentMemoryFile = {
    active: [
      ...file.active.filter((memory) => memory !== replaced),
      ...(alreadyActive ? [] : [{ text, savedOn: input.today }]),
    ],
    earlier:
      replaced === null
        ? file.earlier
        : [{ ...replaced, replacedOn: input.today, replacedBy: text }, ...file.earlier],
  };
  return { text: renderVoiceAgentMemories(next), replaced: replaced?.text ?? null, changed: true };
}

const byteLength = (text: string) => new TextEncoder().encode(text).length;

/**
 * What the voice agent gets: its active memories, never the log, and how to change them. Over the
 * size limit the oldest go first, since a newer memory is the one the user last asked for.
 */
export function buildVoiceAgentMemoryBlock(active: ReadonlyArray<Pick<VoiceAgentMemory, "text">>): {
  readonly text: string;
  readonly truncated: boolean;
} {
  const closing = `</${VOICE_AGENT_MEMORY_TAG}>`;
  const header = [
    `<${VOICE_AGENT_MEMORY_TAG}>`,
    "How the user wants your spoken updates: how detailed, and which topics to cover or leave out. Follow these; what the user says now wins.",
  ].join("\n");
  const footer = [
    `When the user changes how they want updates, call ${MEMORY_PROPOSE_TOOL_NAME} with category "${VOICE_AGENT_MEMORY_CATEGORY}" and the new preference as one short line. If it changes or contradicts a line above, also pass that line's exact text as replaces: the new memory then takes its place, so never save a second memory on one subject. Leave replaces out only for a new subject. Use this category for nothing else. Replaced memories are kept in a log, not shown here.`,
    closing,
  ].join("\n");
  // A closing tag inside a memory would end the block early.
  const lines = active.map((memory) => `- ${memory.text.replaceAll(closing, "").trim()}`);
  const whole = (kept: ReadonlyArray<string>, truncated: boolean) =>
    [
      header,
      "",
      ...(kept.length === 0 && !truncated ? ["Nothing is saved yet."] : kept),
      ...(truncated ? ["(Older ones were left out: these memories are over the size limit.)"] : []),
      "",
      footer,
    ].join("\n");
  let from = 0;
  while (
    from < lines.length &&
    byteLength(whole(lines.slice(from), from > 0)) > VOICE_AGENT_MEMORY_MAX_BYTES
  ) {
    from += 1;
  }
  return { text: whole(lines.slice(from), from > 0), truncated: from > 0 };
}
