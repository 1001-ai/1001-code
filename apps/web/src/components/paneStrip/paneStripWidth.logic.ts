/** Per-browser preset width of each strip column kind, set from a column's header. */
export const PANE_STRIP_WIDTHS_STORAGE_KEY = "t3code:pane-strip-widths:v1";

/** Marks a column whose width steps through presets; its value is the column's width key. */
export const PANE_STRIP_WIDTH_ATTRIBUTE = "data-pane-strip-width";

const PANE_STRIP_WIDTH_PRESETS = ["fit", "third", "half", "two-thirds", "full"] as const;
export type PaneStripWidthPreset = (typeof PANE_STRIP_WIDTH_PRESETS)[number];

/** The thread column, or a pane column by its surface kind. */
export type PaneStripWidthKey = "thread" | `pane:${string}`;

// "fit" is the thread's width that keeps its details card inline; panes have no such width.
const THREAD_PRESETS: ReadonlyArray<PaneStripWidthPreset> = PANE_STRIP_WIDTH_PRESETS;
const PANE_PRESETS: ReadonlyArray<PaneStripWidthPreset> = ["third", "half", "two-thirds", "full"];

const paneStripWidthPresets = (key: PaneStripWidthKey) =>
  key === "thread" ? THREAD_PRESETS : PANE_PRESETS;

const defaultPreset = (key: PaneStripWidthKey): PaneStripWidthPreset =>
  key === "thread" ? "fit" : "half";

/** The column's stored preset, or its default when none is stored or the stored one is not its own. */
export function paneStripWidthPreset(
  stored: Readonly<Record<string, string>>,
  key: PaneStripWidthKey,
): PaneStripWidthPreset {
  const presets = paneStripWidthPresets(key);
  return presets.find((preset) => preset === stored[key]) ?? defaultPreset(key);
}

/** The next preset in the column's cycle, wrapping at either end. */
export function stepPaneStripWidth(
  key: PaneStripWidthKey,
  current: PaneStripWidthPreset,
  direction: 1 | -1,
): PaneStripWidthPreset {
  const presets = paneStripWidthPresets(key);
  const index = Math.max(0, presets.indexOf(current));
  return presets[(index + direction + presets.length) % presets.length] ?? defaultPreset(key);
}

/** Stores the stepped preset, leaving out a default so the record only holds real choices. */
export function withPaneStripWidth(
  stored: Readonly<Record<string, string>>,
  key: PaneStripWidthKey,
  preset: PaneStripWidthPreset,
): Record<string, string> {
  const { [key]: _previous, ...rest } = stored;
  return preset === defaultPreset(key) ? rest : { ...rest, [key]: preset };
}

export const PANE_STRIP_WIDTH_LABELS: Record<
  PaneStripWidthPreset,
  { readonly short: string; readonly long: string }
> = {
  fit: { short: "Fit", long: "Fit the details card" },
  third: { short: "⅓", long: "A third" },
  half: { short: "½", long: "Half" },
  "two-thirds": { short: "⅔", long: "Two thirds" },
  full: { short: "Full", long: "The whole strip" },
};

/** Whether a keydown steps the focused column's width: Mod+Alt+R, with Shift to step back. */
export function paneStripWidthKeyDirection(
  event: Pick<KeyboardEvent, "code" | "altKey" | "shiftKey" | "metaKey" | "ctrlKey">,
  mac: boolean,
): 1 | -1 | null {
  if (event.code !== "KeyR" || !event.altKey) return null;
  if (mac ? !event.metaKey || event.ctrlKey : !event.ctrlKey || event.metaKey) return null;
  return event.shiftKey ? -1 : 1;
}
