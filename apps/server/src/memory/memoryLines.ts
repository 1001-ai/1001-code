const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+/;

/** A memory line as agents and people name it: no list marker, trimmed. */
export const memoryLineText = (line: string): string => line.replace(LIST_ITEM, "").trim();

export const hasMemoryLine = (fileText: string, line: string): boolean => {
  const wanted = memoryLineText(line);
  return fileText.split("\n").some((candidate) => memoryLineText(candidate) === wanted);
};

/** Adds the line as one list item at the end of the file. */
export const appendMemoryLine = (fileText: string, line: string): string => {
  const item = line.startsWith("- ") ? line : `- ${line}`;
  return fileText.trim() === "" ? `${item}\n` : `${fileText.trimEnd()}\n${item}\n`;
};

/**
 * Puts `next` in place of the first line that reads `old`, keeping its list marker, and drops the
 * later ones; with `next` null every one goes. Null when no line reads `old`.
 */
export const replaceMemoryLine = (
  fileText: string,
  old: string,
  next: string | null,
): string | null => {
  const wanted = memoryLineText(old);
  let found = false;
  const lines = fileText.split("\n").flatMap((line) => {
    if (line.trim() === "" || memoryLineText(line) !== wanted) return [line];
    if (found || next === null) {
      found = true;
      return [];
    }
    found = true;
    return [`${LIST_ITEM.exec(line)?.[0] ?? ""}${memoryLineText(next)}`];
  });
  return found ? lines.join("\n") : null;
};
