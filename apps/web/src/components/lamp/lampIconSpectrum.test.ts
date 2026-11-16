import { describe, expect, it } from "vite-plus/test";

import { createLampStarSpectrum } from "./lampIconSpectrum";

const apart = (a: number, b: number) => {
  const gap = Math.abs(a - b) % 360;
  return Math.min(gap, 360 - gap);
};

describe("createLampStarSpectrum", () => {
  it("keeps three stars on the wheel and at least 60 degrees apart while it turns", () => {
    let seed = 7;
    const random = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    const spectrum = createLampStarSpectrum(3, random);
    let closest = 360;
    for (let seconds = 0; seconds < 600; seconds += 0.1) {
      const hues = spectrum(seconds);
      expect(hues).toHaveLength(3);
      for (const hue of hues) expect(hue >= 0 && hue < 360).toBe(true);
      const [a = 0, b = 0, c = 0] = hues;
      closest = Math.min(closest, apart(a, b), apart(b, c), apart(a, c));
    }
    expect(closest).toBeGreaterThanOrEqual(60);
  });
});
