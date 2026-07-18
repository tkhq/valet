// Bun-only compile entry for the single-file `valet` binary.
//
// `bun build --compile` embeds the file referenced by an `import ... with
// { type: "file" }` into the binary. We embed ONE archive (dist/assets.tar,
// produced by build/make-assets-tar.mjs) holding the binary/large assets that
// can't be string-inlined into the esbuild bundle — PGlite's wasm/data and the
// web SPA. Text assets (.md/.sql migrations + plugin skills) are already
// literal-inlined into dist/valet-api.mjs by build/inline-assets.mjs, so they
// are NOT in this archive.
//
// At boot, BEFORE importing the app, we extract the archive to a fresh temp
// dir, point `VALET_ASSET_DIR` at it and set `VALET_BUNDLED=1`, then import the
// esbuild bundle so its `assets/base.ts` seam resolves every binary asset out
// of that temp dir. `cli.ts`'s bottom-level `main()` then runs with argv
// intact. Net app-code change to support this: none.
//
// The tar reader below is a minimal USTAR reader (matches make-assets-tar.mjs):
// 512-byte headers, octal size at offset 124, regular files only, data padded
// to 512. No runtime `tar` binary or npm dependency involved.
import { readFileSync, mkdirSync, mkdtempSync, writeFileSync, existsSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";

// Bun embeds this file into the binary; `assetsTarPath` is a readable
// `/$bunfs/root/...` path at runtime (readable by fs.readFileSync).
import assetsTarPath from "../dist/assets.tar" with { type: "file" };

/** Parse a NUL/space-terminated octal field. */
function parseOctal(buf, offset, len) {
  let str = buf.toString("ascii", offset, offset + len);
  const nul = str.indexOf("\0");
  if (nul !== -1) str = str.slice(0, nul);
  str = str.trim();
  return str.length === 0 ? 0 : parseInt(str, 8);
}

/** Extract every regular file from a USTAR buffer into `destDir`. */
function extractTar(tar, destDir) {
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    // Two consecutive zero blocks mark end-of-archive; a single all-zero
    // header is enough to stop reading.
    if (header.every((b) => b === 0)) break;

    let name = header.toString("utf8", 0, 100);
    const nul = name.indexOf("\0");
    if (nul !== -1) name = name.slice(0, nul);

    const size = parseOctal(header, 124, 12);
    const typeflag = header.toString("ascii", 156, 157);
    offset += 512;

    if (typeflag === "0" || typeflag === "\0") {
      // Guard against a truncated archive: a short read here would silently
      // write a truncated pglite.wasm/data and subtly corrupt the DB engine.
      if (offset + size > tar.length) {
        throw new Error(`assets.tar truncated: entry "${name}" wants ${size} bytes past end`);
      }
      const data = tar.subarray(offset, offset + size);
      const outPath = join(destDir, name);
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, data);
    }
    // Advance past the (512-padded) data payload.
    offset += Math.ceil(size / 512) * 512;
  }
}

/**
 * Extract the embedded assets ONCE per binary build and reuse across restarts.
 * The target dir is keyed on a content hash of the archive, so a given binary
 * always lands on the same dir — no ~19MB re-extraction (and no unbounded temp
 * accumulation) on every boot. A `.complete` marker guards against reusing a
 * partial extraction; extraction stages into a temp dir and atomically renames
 * into place so concurrent first-boots can't observe a half-written tree.
 */
function ensureAssetDir() {
  const tar = readFileSync(assetsTarPath);
  const hash = createHash("sha256").update(tar).digest("hex").slice(0, 16);
  const target = join(tmpdir(), `valet-assets-${hash}`);
  const marker = join(target, ".complete");
  if (existsSync(marker)) return target; // already extracted by a prior run

  const staging = mkdtempSync(join(tmpdir(), "valet-assets-stage-"));
  extractTar(tar, staging);
  writeFileSync(join(staging, ".complete"), "");
  try {
    renameSync(staging, target);
    return target;
  } catch {
    // Target already exists — a concurrent/earlier boot won. It was renamed
    // from a complete staging dir, so it's complete: reuse it, discard ours.
    if (existsSync(marker)) {
      rmSync(staging, { recursive: true, force: true });
      return target;
    }
    // Unexpected (exists but no marker): use our own complete staging dir.
    return staging;
  }
}

process.env.VALET_ASSET_DIR = ensureAssetDir();
process.env.VALET_BUNDLED = "1";

// Import the esbuild bundle; its bottom-level `main()` runs with argv intact.
await import("../dist/valet-api.mjs");
