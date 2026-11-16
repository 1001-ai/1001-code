// @effect-diagnostics nodeBuiltinImport:off - builds archive fixtures for tests.
import * as NodeZlib from "node:zlib";

type TarEntry =
  | { readonly name: string; readonly data: Uint8Array }
  | { readonly name: string; readonly linkTo: string };

const BLOCK = 512;

function header(entry: TarEntry): Uint8Array {
  const block = new Uint8Array(BLOCK);
  const text = new TextEncoder();
  const put = (value: string, offset: number) => block.set(text.encode(value), offset);
  const octal = (value: number, width: number) => value.toString(8).padStart(width - 1, "0");
  put(entry.name, 0);
  put(octal(0o644, 8), 100);
  put(octal(0, 8), 108);
  put(octal(0, 8), 116);
  put(octal("data" in entry ? entry.data.length : 0, 12), 124);
  put(octal(0, 12), 136);
  put("        ", 148);
  put("data" in entry ? "0" : "2", 156);
  if ("linkTo" in entry) put(entry.linkTo, 157);
  put("ustar\u000000", 257);
  const checksum = block.reduce((sum, byte) => sum + byte, 0);
  put(`${octal(checksum, 7)}\u0000 `, 148);
  return block;
}

/** A gzipped ustar archive of files and symbolic links, with the names exactly as given. */
export function tarGz(entries: ReadonlyArray<TarEntry>): Uint8Array {
  const blocks: Uint8Array[] = [];
  for (const entry of entries) {
    blocks.push(header(entry));
    if ("data" in entry) {
      const padded = new Uint8Array(Math.ceil(entry.data.length / BLOCK) * BLOCK);
      padded.set(entry.data);
      blocks.push(padded);
    }
  }
  blocks.push(new Uint8Array(BLOCK * 2));
  const archive = new Uint8Array(blocks.reduce((size, block) => size + block.length, 0));
  let offset = 0;
  for (const block of blocks) {
    archive.set(block, offset);
    offset += block.length;
  }
  return new Uint8Array(NodeZlib.gzipSync(archive));
}
