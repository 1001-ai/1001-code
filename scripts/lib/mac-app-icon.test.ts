// @effect-diagnostics nodeBuiltinImport:off - Reads the committed icon files directly.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import { hashIconComposerProject, MAC_APP_ICON_FILES, MAC_APP_ICONS } from "./mac-app-icon.ts";

const repoRoot = NodePath.join(import.meta.dirname, "../..");

describe("compiled macOS app icons", () => {
  it.each(Object.values(MAC_APP_ICONS))("$compiledDir is compiled from $project", (icon) => {
    const compiledDir = NodePath.join(repoRoot, icon.compiledDir);
    const recorded = NodeFS.readFileSync(
      NodePath.join(compiledDir, MAC_APP_ICON_FILES.sourceHash),
      "utf8",
    ).trim();
    expect(
      hashIconComposerProject(NodePath.join(repoRoot, icon.project)),
      `${icon.project} changed since it was compiled: run \`vp run icons:compile:mac\` on a Mac with Xcode 26 or newer and commit ${icon.compiledDir}.`,
    ).toBe(recorded);
    expect(NodeFS.existsSync(NodePath.join(compiledDir, MAC_APP_ICON_FILES.assetCatalog))).toBe(
      true,
    );
    expect(NodeFS.existsSync(NodePath.join(compiledDir, MAC_APP_ICON_FILES.icns))).toBe(true);
  });
});
