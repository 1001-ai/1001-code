import type { ProviderOptionDescriptor } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildTraitsTriggerDisplay } from "./modelTraits.ts";

describe("auto-compact in the composer chip", () => {
  it.each([
    { currentValue: undefined, label: "High" },
    { currentValue: "150000", label: "High · Compact 150K" },
  ])("shows $label for $currentValue", ({ currentValue, label }) => {
    const descriptors: ReadonlyArray<ProviderOptionDescriptor> = [
      {
        id: "effort",
        label: "Reasoning",
        type: "select",
        options: [{ id: "high", label: "High", isDefault: true }],
      },
      {
        id: "autoCompactWindow",
        label: "Auto-compact after",
        type: "select",
        options: [
          { id: "default", label: "Default", isDefault: true },
          { id: "150000", label: "150K tokens" },
        ],
        ...(currentValue ? { currentValue } : {}),
      },
    ];
    expect(
      buildTraitsTriggerDisplay({
        descriptors,
        primarySelectDescriptorId: "effort",
        ultrathinkPromptControlled: false,
      }).label,
    ).toBe(label);
  });
});
