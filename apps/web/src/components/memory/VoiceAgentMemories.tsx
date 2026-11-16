import type { VoiceAgentMemoryDocument } from "@t3tools/contracts";

/** A hand-edited file may repeat a line, so a repeat's key also counts its occurrence. */
function withKeys<T>(items: ReadonlyArray<T>, textOf: (item: T) => string) {
  const seen = new Map<string, number>();
  return items.map((item) => {
    const text = textOf(item);
    const count = seen.get(text) ?? 0;
    seen.set(text, count + 1);
    return { item, key: `${count}:${text}` };
  });
}

/** The viewer's voice agent memories: the active ones, with the replaced ones folded away. */
export function VoiceAgentMemories(props: { readonly document: VoiceAgentMemoryDocument }) {
  const { document } = props;
  return (
    <div className="space-y-3">
      <div className="min-w-0">
        <div className="truncate text-sm font-medium">Voice agent</div>
        {document.file !== null ? (
          <div className="truncate text-xs text-muted-foreground">
            <code>{document.file}</code>
          </div>
        ) : null}
      </div>
      <p className="text-xs text-muted-foreground">
        How you want the voice agent's spoken updates. Only the voice agent gets these, and a newer
        memory on a subject replaces the older one.
      </p>
      {document.file === null ? (
        <p className="text-sm text-muted-foreground">{document.unavailable}</p>
      ) : document.active.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing saved here yet.</p>
      ) : (
        <ul className="space-y-1.5 text-sm">
          {withKeys(document.active, (memory) => memory.text).map(({ item: memory, key }) => (
            <li key={key} className="[overflow-wrap:anywhere]">
              {memory.text}
              {memory.savedOn !== null ? (
                <span className="ms-2 text-xs text-muted-foreground">saved {memory.savedOn}</span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {document.earlier.length > 0 ? (
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer select-none">
            Earlier ({document.earlier.length})
          </summary>
          <ul className="mt-2 space-y-2">
            {withKeys(document.earlier, (entry) => entry.text).map(({ item: entry, key }) => (
              <li key={key} className="[overflow-wrap:anywhere]">
                <span className="line-through">{entry.text}</span>
                {entry.replacedOn !== null ? (
                  <div>
                    Replaced {entry.replacedOn}
                    {entry.replacedBy !== null ? ` by: ${entry.replacedBy}` : ""}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
