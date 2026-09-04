#!/usr/bin/env node
/**
 * Generates the PWA icon PNGs in `public/icons/` from the same geometry as
 * `public/favicon.svg` (rounded navy square, blue V chevron). Pure Node — no
 * native rasterizer dependency — so the output is deterministic and the
 * files can be regenerated on any machine:
 *
 *   node scripts/generate-pwa-icons.mjs
 *
 * Outputs:
 *   icon-192.png            192×192, rounded-rect art (purpose "any")
 *   icon-512.png            512×512, rounded-rect art (purpose "any")
 *   icon-512-maskable.png   512×512, full-bleed background; the chevron
 *                           stays inside the maskable safe zone (inner 80%
 *                           circle) so platform masks do not clip it
 *   apple-touch-icon.png    180×180, full-bleed (iOS applies its own mask)
 */
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// --- Art, in favicon.svg's 32×32 coordinate space -------------------------

const BG = [0x11, 0x1a, 0x2e]; // #111a2e
const STROKE = [0x4d, 0x7d, 0xfa]; // #4d7dfa
const CORNER_RADIUS = 7; // rect rx
const CHEVRON = [
  [8, 9],
  [16, 24],
  [24, 9],
]; // path M8 9 L16 24 L24 9
const STROKE_HALF_WIDTH = 3.4 / 2; // stroke-width 3.4, round caps/joins

/** Distance from point (px,py) to segment (ax,ay)-(bx,by). */
function segmentDistance(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  const cx = ax + t * dx - px;
  const cy = ay + t * dy - py;
  return Math.hypot(cx, cy);
}

/** Signed distance to a rounded rect centered on [0,32]×[0,32]. Negative = inside. */
function roundedRectDistance(px, py, radius) {
  const qx = Math.abs(px - 16) - (16 - radius);
  const qy = Math.abs(py - 16) - (16 - radius);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
}

/**
 * Renders one icon as raw RGBA. `rounded` toggles the rounded-rect vs
 * full-bleed background. `glyphScale` shrinks the chevron toward the center
 * (used to keep the maskable variant inside the safe zone).
 */
function render(size, { rounded, glyphScale = 1 }) {
  const pixels = Buffer.alloc(size * size * 4);
  const subsamples = 4; // 4×4 grid per pixel for anti-aliasing
  const step = 1 / subsamples;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let bgCoverage = 0;
      let strokeCoverage = 0;
      for (let sy = 0; sy < subsamples; sy++) {
        for (let sx = 0; sx < subsamples; sx++) {
          // Sample point mapped into the 32×32 art space.
          const ax = ((x + (sx + 0.5) * step) / size) * 32;
          const ay = ((y + (sy + 0.5) * step) / size) * 32;
          const inBg = rounded ? roundedRectDistance(ax, ay, CORNER_RADIUS) <= 0 : true;
          if (!inBg) continue;
          bgCoverage++;
          const gx = 16 + (ax - 16) / glyphScale;
          const gy = 16 + (ay - 16) / glyphScale;
          const d = Math.min(
            segmentDistance(gx, gy, ...CHEVRON[0], ...CHEVRON[1]),
            segmentDistance(gx, gy, ...CHEVRON[1], ...CHEVRON[2]),
          );
          if (d <= STROKE_HALF_WIDTH) strokeCoverage++;
        }
      }
      const total = subsamples * subsamples;
      const alpha = Math.round((bgCoverage / total) * 255);
      const mix = bgCoverage === 0 ? 0 : strokeCoverage / bgCoverage;
      const offset = (y * size + x) * 4;
      for (let c = 0; c < 3; c++) {
        pixels[offset + c] = Math.round(BG[c] + (STROKE[c] - BG[c]) * mix);
      }
      pixels[offset + 3] = alpha;
    }
  }
  return pixels;
}

// --- Minimal PNG encoder (8-bit RGBA, no interlace) ------------------------

const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});

function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(size, pixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  // Prefix each scanline with filter byte 0 (None).
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// --- Emit -------------------------------------------------------------------

const outDir = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "icons");
mkdirSync(outDir, { recursive: true });

const outputs = [
  ["icon-192.png", 192, { rounded: true }],
  ["icon-512.png", 512, { rounded: true }],
  // Maskable: full-bleed, chevron scaled to sit inside the inner 80% circle.
  ["icon-512-maskable.png", 512, { rounded: false, glyphScale: 0.9 }],
  ["apple-touch-icon.png", 180, { rounded: false }],
];

for (const [name, size, options] of outputs) {
  writeFileSync(join(outDir, name), encodePng(size, render(size, options)));
  console.log(`wrote public/icons/${name}`);
}
