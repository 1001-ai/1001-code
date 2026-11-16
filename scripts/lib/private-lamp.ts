// @effect-diagnostics nodeBuiltinImport:off - Vite loads this before any Effect runtime.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { searchForWorkspaceRoot, type Plugin } from "vite-plus";

const LAMP_ENTRY = "web/lamp/index.ts";

/**
 * Where `@1001-private/lamp` comes from: the private checkout that `T3CODE_PRIVATE_DIR` names,
 * or null for the public fallback the web tsconfig's `paths` name. A set variable without the
 * module fails, so a private build never ships the fallback by mistake.
 */
export function resolvePrivateLampEntry(
  privateDir: string | undefined,
  exists: (path: string) => boolean = NodeFS.existsSync,
): string | null {
  const dir = privateDir?.trim();
  if (!dir) return null;
  const entry = NodePath.resolve(dir, LAMP_ENTRY);
  if (!exists(entry)) {
    throw new Error(
      `T3CODE_PRIVATE_DIR is set to ${dir}, but ${entry} does not exist. Check out the private repository there, or unset T3CODE_PRIVATE_DIR to build with the public icon.`,
    );
  }
  return entry;
}

export function privateLampPlugin(privateDir = process.env.T3CODE_PRIVATE_DIR): Plugin {
  const entry = resolvePrivateLampEntry(privateDir);
  return {
    name: "1001-code:private-lamp",
    config: (config) =>
      entry === null
        ? undefined
        : {
            resolve: {
              alias: [{ find: /^@1001-private\/lamp$/, replacement: entry }],
              // The private checkout has no node_modules: its bare imports resolve from the app.
              dedupe: ["react", "react-dom"],
            },
            // A set allow list replaces Vite's default, so it keeps the workspace root.
            server: {
              fs: {
                allow: [
                  searchForWorkspaceRoot(config.root ?? process.cwd()),
                  NodePath.dirname(entry),
                ],
              },
            },
          },
  };
}
