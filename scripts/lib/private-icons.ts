// @effect-diagnostics nodeBuiltinImport:off - build scripts and Vite call these synchronously.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import type { Plugin } from "vite-plus";

import { DEVELOPMENT_PUBLIC_ICON_OVERRIDES } from "./brand-assets.ts";

type Exists = (path: string) => boolean;

/**
 * The private checkout that `T3CODE_PRIVATE_DIR` names, whose `assets/` mirrors this
 * repository's, or null for the public icons. A set variable without that folder fails, so a
 * private build never ships the public icons by mistake.
 */
export function resolvePrivateIconsRoot(
  privateDir = process.env.T3CODE_PRIVATE_DIR,
  exists: Exists = NodeFS.existsSync,
): string | null {
  const dir = privateDir?.trim();
  if (!dir) return null;
  const root = NodePath.resolve(dir);
  const assets = NodePath.join(root, "assets");
  if (!exists(assets)) {
    throw new Error(
      `T3CODE_PRIVATE_DIR is set to ${dir}, but ${assets} does not exist. Check out the private repository there, or unset T3CODE_PRIVATE_DIR to build with the public icons.`,
    );
  }
  return root;
}

/** An icon file by its repository-relative path: the private copy when there is one. */
export function iconSource(
  repoRoot: string,
  relativePath: string,
  privateRoot = resolvePrivateIconsRoot(),
  exists: Exists = NodeFS.existsSync,
): string {
  const privatePath = privateRoot === null ? null : NodePath.join(privateRoot, relativePath);
  return privatePath !== null && exists(privatePath)
    ? privatePath
    : NodePath.join(repoRoot, relativePath);
}

const MAC_APP_ICON_DIRS = {
  latest: "assets/prod/macos-app-icon",
  nightly: "assets/nightly/macos-app-icon",
} as const;

/**
 * Ships a compiled macOS icon when the private checkout has one: `Assets.car` for macOS 26,
 * which follows light and dark mode, and `icon.icns` for older macOS. actool named the
 * catalog's icon `Icon`, so Info.plist names it too.
 */
export function withPrivateMacAppIcon<T extends { readonly extendInfo: Record<string, unknown> }>(
  channel: keyof typeof MAC_APP_ICON_DIRS,
  mac: T,
  privateRoot = resolvePrivateIconsRoot(),
  exists: Exists = NodeFS.existsSync,
) {
  if (privateRoot === null) return mac;
  const dir = NodePath.join(privateRoot, MAC_APP_ICON_DIRS[channel]);
  const icns = NodePath.join(dir, "icon.icns");
  const assetCatalog = NodePath.join(dir, "Assets.car");
  if (!exists(icns) || !exists(assetCatalog)) return mac;
  return {
    ...mac,
    icon: icns,
    extendInfo: { ...mac.extendInfo, CFBundleIconName: "Icon" },
    extraResources: [{ from: assetCatalog, to: "Assets.car" }],
  };
}

/** The web client's public icons the private checkout replaces, by file name. */
export function privateWebPublicIcons(
  privateRoot: string | null,
  exists: Exists = NodeFS.existsSync,
): ReadonlyMap<string, string> {
  if (privateRoot === null) return new Map();
  return new Map(
    DEVELOPMENT_PUBLIC_ICON_OVERRIDES.map(
      (icon) =>
        [
          NodePath.basename(icon.targetRelativePath),
          NodePath.join(privateRoot, icon.sourceRelativePath),
        ] as const,
    ).filter(([, file]) => exists(file)),
  );
}

export function privateWebIconsPlugin(privateRoot = resolvePrivateIconsRoot()): Plugin {
  const icons = privateWebPublicIcons(privateRoot);
  return {
    name: "1001-code:private-icons",
    configureServer: (server) => {
      if (icons.size === 0) return;
      server.middlewares.use((req, res, next) => {
        const file = icons.get((req.url ?? "").split("?")[0]!.slice(1));
        if (file === undefined) return next();
        res.setHeader("Content-Type", file.endsWith(".ico") ? "image/x-icon" : "image/png");
        NodeFS.createReadStream(file).pipe(res);
      });
    },
    // Vite copies `public/` before it writes the bundle, so these replace the public copies.
    writeBundle: (options) => {
      if (!options.dir) return;
      for (const [name, file] of icons) NodeFS.copyFileSync(file, NodePath.join(options.dir, name));
    },
  };
}
