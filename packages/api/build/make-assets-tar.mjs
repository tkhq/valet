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
// The archive is built for ONE compile target, because sharp's native addon and
// libvips differ per platform. It holds dist/assets plus the `@img` packages for
// that target from dist/sharp-native/<platform>/, and the build fails if the
// result lacks them or carries another platform's.
//
//   node build/make-assets-tar.mjs                       # host platform
//   node build/make-assets-tar.mjs --target bun-linux-arm64
import { existsSync, readdirSync, statSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { sharpPackagesFor, sharpPlatformFor } from "./sharp-platforms.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const apiRoot = resolve(here, ".."); // packages/api
const assetsDir = resolve(apiRoot, "dist/assets");
const outFile = resolve(apiRoot, "dist/assets.tar");
const nativeDir = resolve(apiRoot, "dist/sharp-native");

/** Read `--target <t>` / `--target=<t>` from argv, else undefined (host build). */
function parseTarget(argv) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--target") return argv[i + 1];
    if (argv[i].startsWith("--target=")) return argv[i].slice("--target=".length);
  }
  return undefined;
}
const target = parseTarget(process.argv.slice(2));
const sharpPlatform = sharpPlatformFor(target);
const SHARP_IMG = "sharp/node_modules/@img/";

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

const entries = walk(assetsDir).map((full) => ({ full, rel: relative(assetsDir, full).split(sep).join("/") }));
for (const pkg of sharpPackagesFor(sharpPlatform)) {
  const pkgDir = resolve(nativeDir, sharpPlatform, pkg);
  if (!existsSync(pkgDir)) {
    throw new Error(`make-assets-tar: ${pkg} missing at ${pkgDir} — run build:assets first (VALET_SHARP_STAGE=all stages every target)`);
  }
  for (const full of walk(pkgDir)) {
    entries.push({ full, rel: SHARP_IMG + pkg.slice("@img/".length) + "/" + relative(pkgDir, full).split(sep).join("/") });
  }
}
entries.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0)); // deterministic ordering

// A binary that embeds another platform's sharp starts, then fails at the first
// image operation (or at boot). Fail the build instead.
const imgPackages = new Set();
for (const { rel } of entries) {
  // `@img/colour` is platform-neutral JS; only the sharp addon and libvips vary.
  const name = rel.startsWith(SHARP_IMG) ? rel.slice(SHARP_IMG.length).split("/")[0] : "";
  if (name.startsWith("sharp-")) imgPackages.add(name);
}
const wantPackages = sharpPackagesFor(sharpPlatform).map((n) => n.slice("@img/".length));
const sameSet = imgPackages.size === wantPackages.length && wantPackages.every((n) => imgPackages.has(n));
if (!sameSet) {
  throw new Error(
    `make-assets-tar: sharp packages for ${target ?? "host"} must be exactly [${wantPackages}] but the archive has [${[...imgPackages]}]`,
  );
}
for (const n of wantPackages) {
  if (!entries.some((e) => e.rel === `${SHARP_IMG}${n}/package.json`)) {
    throw new Error(`make-assets-tar: ${n} has no package.json in the archive`);
  }
}
if (!entries.some((e) => e.rel.startsWith(`${SHARP_IMG}sharp-${sharpPlatform}/lib/`) && e.rel.endsWith(".node"))) {
  throw new Error(`make-assets-tar: sharp-${sharpPlatform} has no .node addon in the archive`);
}

const chunks = [];
let count = 0;
for (const { full, rel } of entries) {
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
console.log(`make-assets-tar: ${count} files (sharp ${sharpPlatform}) -> ${outFile}`);
