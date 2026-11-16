import { describe, expect, it } from "vite-plus/test";

import { resolvePrivateLampEntry } from "./private-lamp.ts";

describe("resolvePrivateLampEntry", () => {
  it("leaves the public fallback when T3CODE_PRIVATE_DIR is unset or blank", () => {
    expect(resolvePrivateLampEntry(undefined, () => true)).toBeNull();
    expect(resolvePrivateLampEntry("  ", () => true)).toBeNull();
  });

  it("takes the private checkout's module when it is there", () => {
    expect(resolvePrivateLampEntry("/work/private", (path) => path.endsWith("index.ts"))).toBe(
      "/work/private/web/lamp/index.ts",
    );
  });

  it("fails when the variable is set but the module is missing", () => {
    expect(() => resolvePrivateLampEntry("/work/private", () => false)).toThrow(
      "/work/private/web/lamp/index.ts does not exist",
    );
  });
});
