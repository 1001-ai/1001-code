// @effect-diagnostics nodeBuiltinImport:off - createBuildConfig and the compile script call these synchronously.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { BRAND_ASSET_PATHS } from "./brand-assets.ts";

// actool needs Xcode 26 or newer, so `vp run icons:compile:mac` compiles each packaged Icon
// Composer project into the repository and the desktop build only copies the result.
export const MAC_APP_ICONS = {
  latest: {
    project: BRAND_ASSET_PATHS.productionIconComposerProject,
    compiledDir: "assets/prod/macos-app-icon",
  },
  nightly: {
    project: BRAND_ASSET_PATHS.nightlyIconComposerProject,
    compiledDir: "assets/nightly/macos-app-icon",
  },
} as const;

export const MAC_APP_ICON_FILES = {
  assetCatalog: "Assets.car",
  icns: "icon.icns",
  sourceHash: "source.sha256",
} as const;

// actool names the catalog's icon after `--app-icon`; Info.plist must use the same name.
export const MAC_APP_ICON_NAME = "Icon";

/** SHA-256 over the project's file paths and bytes, ignoring Finder's dotfiles. */
export function hashIconComposerProject(projectDir: string): string {
  const hash = NodeCrypto.createHash("sha256");
  const files = (NodeFS.readdirSync(projectDir, { recursive: true }) as ReadonlyArray<string>)
    .filter((file) => !file.split(NodePath.sep).some((part) => part.startsWith(".")))
    .filter((file) => NodeFS.statSync(NodePath.join(projectDir, file)).isFile())
    .map((file) => file.split(NodePath.sep).join("/"))
    .toSorted();
  for (const file of files) {
    hash.update(`${file}\0`);
    hash.update(NodeFS.readFileSync(NodePath.join(projectDir, file)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

/**
 * Ships the committed `Assets.car` (macOS 26's appearance-aware icon) and `icon.icns` (older
 * macOS), which is what electron-builder makes when `mac.icon` names an Icon Composer project.
 */
export function withMacAppIcon<T extends { readonly extendInfo: Record<string, unknown> }>(
  repoRoot: string,
  channel: keyof typeof MAC_APP_ICONS,
  mac: T,
) {
  const compiledDir = NodePath.join(repoRoot, MAC_APP_ICONS[channel].compiledDir);
  return {
    ...mac,
    icon: NodePath.join(compiledDir, MAC_APP_ICON_FILES.icns),
    extendInfo: { ...mac.extendInfo, CFBundleIconName: MAC_APP_ICON_NAME },
    extraResources: [
      {
        from: NodePath.join(compiledDir, MAC_APP_ICON_FILES.assetCatalog),
        to: MAC_APP_ICON_FILES.assetCatalog,
      },
    ],
  };
}
