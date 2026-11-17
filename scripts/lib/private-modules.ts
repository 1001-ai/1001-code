// @effect-diagnostics nodeBuiltinImport:off - Vite loads this before any Effect runtime.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { searchForWorkspaceRoot, type Plugin } from "vite-plus";

const PRIVATE_MODULES = [
  { module: "@1001-private/lamp", file: "web/lamp/index.ts" },
  { module: "@1001-private/wordmark", file: "web/wordmark/index.ts" },
] as const;

/**
 * Where each `@1001-private/*` module comes from: the private checkout that `T3CODE_PRIVATE_DIR`
 * names, or null for the public fallbacks the web tsconfig's `paths` name. A set variable without
 * a module fails, so a private build never ships a fallback by mistake.
 */
export function resolvePrivateModuleEntries(
  privateDir: string | undefined,
  exists: (path: string) => boolean = NodeFS.existsSync,
) {
  const dir = privateDir?.trim();
  if (!dir) return null;
  return PRIVATE_MODULES.map(({ module, file }) => {
    const entry = NodePath.resolve(dir, file);
    if (!exists(entry)) {
      throw new Error(
        `T3CODE_PRIVATE_DIR is set to ${dir}, but ${entry} does not exist. Check out the private repository there, or unset T3CODE_PRIVATE_DIR to build with the public fallbacks.`,
      );
    }
    return { module, entry };
  });
}

export function privateModulesPlugin(privateDir = process.env.T3CODE_PRIVATE_DIR): Plugin {
  const entries = resolvePrivateModuleEntries(privateDir);
  return {
    name: "1001-code:private-modules",
    config: (config) =>
      entries === null
        ? undefined
        : {
            resolve: {
              alias: entries.map(({ module, entry }) => ({
                find: new RegExp(`^${module}$`),
                replacement: entry,
              })),
              // The private checkout has no node_modules: its bare imports resolve from the app.
              dedupe: ["react", "react-dom"],
            },
            // A set allow list replaces Vite's default, so it keeps the workspace root.
            server: {
              fs: {
                allow: [
                  searchForWorkspaceRoot(config.root ?? process.cwd()),
                  ...entries.map(({ entry }) => NodePath.dirname(entry)),
                ],
              },
            },
          },
  };
}
