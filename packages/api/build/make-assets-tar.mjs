// Packs the non-inlinable binary/large assets (PGlite wasm/data + the web SPA)
// that `build/copy-assets.mjs` laid down in `dist/assets/` into a single
// dependency-free USTAR archive `dist/assets.tar`.
//
// Why a tar at all: `bun build --compile` can embed exactly ONE file per
// `import ... with { type: "file" }`. One archive lets the compile wrapper
// (build/compile-entry.mjs) embed the whole asset tree with a single import,
// then extract it to a temp dir at boot and point `VALET_ASSET_DIR` at it.
//
// Why hand-rolled (not system `tar`): a pure-Node writer is deterministic and
// adds NO build- or runtime dependency, and — paired with the matching reader
// in compile-entry.mjs — sidesteps macOS bsdtar's PAX extended headers. Every
// asset path here is < 100 bytes, so plain USTAR name fields suffice (no
// GNU/PAX long-name extension needed).
//
//   node build/make-assets-tar.mjs
import { readdirSync, statSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const apiRoot = resolve(here, ".."); // packages/api
const assetsDir = resolve(apiRoot, "dist/assets");
const outFile = resolve(apiRoot, "dist/assets.tar");

/** Recursively collect every regular file under `dir` (absolute paths). */
function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = resolve(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walk(full));
    else if (st.isFile()) out.push(full);
  }
  return out;
}

/** Write `value` as a NUL-terminated octal field of `len` bytes into `buf`. */
function writeOctal(buf, offset, len, value) {
  // `len - 1` octal digits, left-padded with '0', then a trailing NUL.
  const str = value.toString(8).padStart(len - 1, "0") + "\0";
  buf.write(str, offset, len, "ascii");
}

/** Build one 512-byte USTAR header for a regular file. */
function header(name, size) {
  const buf = Buffer.alloc(512);
  buf.write(name, 0, 100, "utf8"); // name
  writeOctal(buf, 100, 8, 0o644); // mode
  writeOctal(buf, 108, 8, 0); // uid
  writeOctal(buf, 116, 8, 0); // gid
  writeOctal(buf, 124, 12, size); // size
  writeOctal(buf, 136, 12, 0); // mtime (fixed → deterministic)
  buf.write("        ", 148, 8, "ascii"); // chksum placeholder (8 spaces)
  buf.write("0", 156, 1, "ascii"); // typeflag: regular file
  buf.write("ustar\0", 257, 6, "ascii"); // magic
  buf.write("00", 263, 2, "ascii"); // version
  // uid/gid names, dev numbers, prefix all left as NULs.

  // Checksum: unsigned sum of all header bytes (with chksum field as spaces),
  // written as a 6-digit octal number, a NUL, then a space.
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += buf[i];
  const chk = sum.toString(8).padStart(6, "0") + "\0 ";
  buf.write(chk, 148, 8, "ascii");
  return buf;
}

const files = walk(assetsDir).sort(); // sort → deterministic ordering
const chunks = [];
let count = 0;
for (const full of files) {
  const rel = relative(assetsDir, full).split(sep).join("/"); // POSIX separators
  if (Buffer.byteLength(rel, "utf8") > 100) {
    throw new Error(`make-assets-tar: path too long for USTAR (>100 bytes): ${rel}`);
  }
  const data = readFileSync(full);
  chunks.push(header(rel, data.length));
  chunks.push(data);
  const pad = (512 - (data.length % 512)) % 512;
  if (pad > 0) chunks.push(Buffer.alloc(pad));
  count++;
}
// Two 512-byte zero blocks mark end-of-archive.
chunks.push(Buffer.alloc(1024));

writeFileSync(outFile, Buffer.concat(chunks));
console.log(`make-assets-tar: ${count} files -> ${outFile}`);
