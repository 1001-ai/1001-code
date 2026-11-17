import { describe, expect, it } from "vite-plus/test";

import { resolvePrivateModuleEntries } from "./private-modules.ts";

describe("resolvePrivateModuleEntries", () => {
  it("leaves the public fallbacks when T3CODE_PRIVATE_DIR is unset or blank", () => {
    expect(resolvePrivateModuleEntries(undefined, () => true)).toBeNull();
    expect(resolvePrivateModuleEntries("  ", () => true)).toBeNull();
  });

  it("takes the private checkout's modules when they are there", () => {
    expect(
      resolvePrivateModuleEntries("/work/private", (path) => path.endsWith("index.ts")),
    ).toEqual([
      { module: "@1001-private/lamp", entry: "/work/private/web/lamp/index.ts" },
      { module: "@1001-private/wordmark", entry: "/work/private/web/wordmark/index.ts" },
    ]);
  });

  it.each(["/work/private/web/lamp/index.ts", "/work/private/web/wordmark/index.ts"])(
    "fails when the variable is set but %s is missing",
    (missing) => {
      expect(() =>
        resolvePrivateModuleEntries("/work/private", (path) => path !== missing),
      ).toThrow(`${missing} does not exist`);
    },
  );
});
