import type { ProviderOptionDescriptor } from "@t3tools/contracts";

/**
 * The composer chip text for the per-thread auto-compact option: null while it follows the
 * provider setting, and undefined for any other option.
 */
export function autoCompactTraitLabel(
  descriptor: ProviderOptionDescriptor,
  currentValue: string | boolean | undefined,
): string | null | undefined {
  if (descriptor.id !== "autoCompactWindow" || descriptor.type !== "select") return undefined;
  const tokens = Number(currentValue);
  return Number.isFinite(tokens) && tokens > 0 ? `Compact ${tokens / 1000}K` : null;
}
