import type { ModelCapabilities, ModelSelection } from "@t3tools/contracts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";

const OPTION_ID = "autoCompactWindow";
const PRESET_TOKENS = [100_000, 150_000, 200_000, 300_000, 500_000];

/** Adds the per-thread "Auto-compact after" list, with the sizes below the model's largest window. */
export function withThreadAutoCompactOption(
  capabilities: ModelCapabilities | null,
  runtime: {
    readonly fixedContextWindowTokens?: number | undefined;
    readonly contextWindowTokens?: Readonly<Record<string, number>> | undefined;
  },
): ModelCapabilities | null {
  const descriptors = capabilities?.optionDescriptors ?? [];
  // The composer reads a model's first list as its reasoning control, so this one only follows another.
  if (!descriptors.some((descriptor) => descriptor.type === "select")) return capabilities;
  const largestWindow =
    runtime.fixedContextWindowTokens ??
    Math.max(0, ...Object.values(runtime.contextWindowTokens ?? {}));
  const presets = PRESET_TOKENS.filter((tokens) => largestWindow === 0 || tokens < largestWindow);
  if (presets.length === 0) return capabilities;
  return {
    ...capabilities,
    optionDescriptors: [
      ...descriptors,
      {
        id: OPTION_ID,
        label: "Auto-compact after",
        type: "select",
        options: [
          { id: "default", label: "Default", isDefault: true },
          ...presets.map((tokens) => ({
            id: String(tokens),
            label: `${tokens / 1000}K tokens`,
          })),
        ],
      },
    ],
  };
}

/** The thread's chosen window as Claude's `autoCompactWindow`, or "" to use the provider setting. */
export function threadAutoCompactWindow(selection: ModelSelection): string {
  const value = getModelSelectionStringOptionValue(selection, OPTION_ID);
  return value !== undefined && PRESET_TOKENS.some((tokens) => String(tokens) === value)
    ? value
    : "";
}
