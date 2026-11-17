import { describe, expect, it } from "vite-plus/test";

import {
  iconSource,
  privateWebPublicIcons,
  resolvePrivateIconsRoot,
  withPrivateMacAppIcon,
} from "./private-icons.ts";

const has =
  (...paths: ReadonlyArray<string>) =>
  (path: string) =>
    paths.includes(path);

describe("resolvePrivateIconsRoot", () => {
  it("leaves the public icons when T3CODE_PRIVATE_DIR is unset or blank", () => {
    expect(resolvePrivateIconsRoot(undefined, () => true)).toBeNull();
    expect(resolvePrivateIconsRoot("  ", () => true)).toBeNull();
  });

  it("fails when the variable is set but the checkout has no assets folder", () => {
    expect(() => resolvePrivateIconsRoot("/work/private", () => false)).toThrow(
      "/work/private/assets does not exist",
    );
  });
});

describe("iconSource", () => {
  const icon = "assets/prod/black-macos-1024.png";

  it("takes the private file at the same relative path when it is there", () => {
    expect(iconSource("/repo", icon, "/work/private", has(`/work/private/${icon}`))).toBe(
      `/work/private/${icon}`,
    );
  });

  it("keeps the public file when the private checkout lacks it or is not set", () => {
    expect(iconSource("/repo", icon, "/work/private", () => false)).toBe(`/repo/${icon}`);
    expect(iconSource("/repo", icon, null, () => true)).toBe(`/repo/${icon}`);
  });
});

describe("withPrivateMacAppIcon", () => {
  const mac = { icon: "icon.icns", extendInfo: { Kept: true } };
  const dir = "/work/private/assets/nightly/macos-app-icon";

  it("ships the compiled icon of the build's channel", () => {
    expect(
      withPrivateMacAppIcon(
        "nightly",
        mac,
        "/work/private",
        has(`${dir}/icon.icns`, `${dir}/Assets.car`),
      ),
    ).toEqual({
      icon: `${dir}/icon.icns`,
      extendInfo: { Kept: true, CFBundleIconName: "Icon" },
      extraResources: [{ from: `${dir}/Assets.car`, to: "Assets.car" }],
    });
  });

  it("keeps the staged icon without both compiled files", () => {
    expect(withPrivateMacAppIcon("nightly", mac, "/work/private", has(`${dir}/icon.icns`))).toBe(
      mac,
    );
    expect(withPrivateMacAppIcon("latest", mac, null, () => true)).toBe(mac);
  });
});

describe("privateWebPublicIcons", () => {
  it("maps the web client's public icons to the private development icons it has", () => {
    const favicon = "/work/private/assets/dev/blueprint-web-favicon.ico";
    expect([...privateWebPublicIcons("/work/private", has(favicon))]).toEqual([
      ["favicon.ico", favicon],
    ]);
    expect(privateWebPublicIcons(null, () => true).size).toBe(0);
  });
});
