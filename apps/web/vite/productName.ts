import type { Plugin } from "vite-plus";

// This fork ships as 1001 Code. Renaming at build time leaves upstream's source strings alone, so
// its merges stay clean and strings it adds later are renamed too. Only the web client is renamed:
// the server, the CLI and every identifier keep upstream's name.

// Upstream's name stays where it names something outside this build: its store app, its GitHub
// repository, its GNOME extension, and the session label a server gives a linked machine.
const KEPT_PHRASES = [
  "Enjoying T3 Code?",
  "helps T3 Code grow",
  "T3 Code app for iPhone and Android",
  "Install T3 Code on your phone",
  "· T3 Code ${device.appVersion}",
  "T3 Code SnapShots",
  "T3 Code · …",
];

const escapePattern = (text: string) => text.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);

// Kept phrases come first so they win over the bare name, which JSX text may wrap across lines.
const UPSTREAM_NAME = new RegExp(
  `${KEPT_PHRASES.map(escapePattern).join("|")}|\\bT3(\\s+)Code\\b`,
  "g",
);

const renameProduct = (text: string) =>
  text.replace(UPSTREAM_NAME, (match: string, gap: string | undefined) =>
    gap === undefined ? match : `1001${gap}Code`,
  );

export function productNamePlugin(): Plugin {
  return {
    name: "1001-code:product-name",
    // Tests assert upstream's strings, so they run on the source as written.
    apply: (_config, env) => env.mode !== "test",
    transform: {
      filter: { id: { exclude: /\/node_modules\// }, code: "T3" },
      handler(code) {
        const renamed = renameProduct(code);
        // A null map keeps the existing sourcemap: the rename never moves text to another line.
        return renamed === code ? null : { code: renamed, map: null };
      },
    },
    transformIndexHtml: (html) => renameProduct(html),
  };
}
