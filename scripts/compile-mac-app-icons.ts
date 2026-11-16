#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off

// Compiles the packaged Icon Composer projects with actool (Xcode 26 or newer) into the files the
// desktop build ships, so building the app needs only the Command Line Tools.

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  hashIconComposerProject,
  MAC_APP_ICON_FILES,
  MAC_APP_ICON_NAME,
  MAC_APP_ICONS,
} from "./lib/mac-app-icon.ts";

const repoRoot = NodePath.join(import.meta.dirname, "..");

try {
  NodeChildProcess.execFileSync("xcrun", ["actool", "--version"], { stdio: "ignore" });
} catch {
  console.error("actool not found. Compiling the macOS app icons needs Xcode 26 or newer.");
  process.exit(1);
}

for (const { project, compiledDir } of Object.values(MAC_APP_ICONS)) {
  const tmpDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mac-app-icon-"));
  try {
    const iconPath = NodePath.join(tmpDir, `${MAC_APP_ICON_NAME}.icon`);
    const outputDir = NodePath.join(tmpDir, "out");
    NodeFS.cpSync(NodePath.join(repoRoot, project), iconPath, { recursive: true });
    NodeFS.mkdirSync(outputDir);
    // The arguments electron-builder's macosIconComposer.js passes.
    NodeChildProcess.execFileSync(
      "xcrun",
      [
        "actool",
        iconPath,
        "--compile",
        outputDir,
        "--output-format",
        "human-readable-text",
        "--notices",
        "--warnings",
        "--output-partial-info-plist",
        NodePath.join(outputDir, "assetcatalog_generated_info.plist"),
        "--app-icon",
        MAC_APP_ICON_NAME,
        "--include-all-app-icons",
        "--accent-color",
        "AccentColor",
        "--enable-on-demand-resources",
        "NO",
        "--development-region",
        "en",
        "--target-device",
        "mac",
        "--minimum-deployment-target",
        "26.0",
        "--platform",
        "macosx",
      ],
      { stdio: "inherit" },
    );

    const targetDir = NodePath.join(repoRoot, compiledDir);
    NodeFS.mkdirSync(targetDir, { recursive: true });
    NodeFS.copyFileSync(
      NodePath.join(outputDir, MAC_APP_ICON_FILES.assetCatalog),
      NodePath.join(targetDir, MAC_APP_ICON_FILES.assetCatalog),
    );
    NodeFS.copyFileSync(
      NodePath.join(outputDir, `${MAC_APP_ICON_NAME}.icns`),
      NodePath.join(targetDir, MAC_APP_ICON_FILES.icns),
    );
    NodeFS.writeFileSync(
      NodePath.join(targetDir, MAC_APP_ICON_FILES.sourceHash),
      `${hashIconComposerProject(NodePath.join(repoRoot, project))}\n`,
    );
    console.log(`${project} -> ${compiledDir}`);
  } finally {
    NodeFS.rmSync(tmpDir, { recursive: true, force: true });
  }
}
