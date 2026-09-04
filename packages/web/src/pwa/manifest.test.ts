/**
 * Validates the install surface: the web app manifest parses, declares the
 * fields Chrome's installability check needs, every icon it references
 * exists with the declared pixel size, and `index.html` links the manifest
 * and the Apple metadata.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const pkgRoot = join(__dirname, "..", "..");
const publicDir = join(pkgRoot, "public");
const manifest = JSON.parse(readFileSync(join(publicDir, "manifest.webmanifest"), "utf-8"));

/** Reads width×height from a PNG's IHDR chunk. */
function pngSize(path: string): { width: number; height: number } {
  const bytes = readFileSync(path);
  expect(bytes.subarray(0, 8)).toEqual(
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  );
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

describe("web app manifest", () => {
  it("declares the fields required for installability", () => {
    expect(manifest.name).toBe("Valet");
    expect(manifest.short_name).toBe("Valet");
    expect(manifest.display).toBe("standalone");
    expect(manifest.id).toBe("/");
    expect(manifest.start_url).toBe("/");
    expect(manifest.scope).toBe("/");
    expect(manifest.theme_color).toMatch(/^#[0-9a-f]{6}$/);
    expect(manifest.background_color).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("declares a 192px and a 512px any-purpose icon and a 512px maskable icon", () => {
    const byPurpose = (purpose: string) =>
      manifest.icons.filter((icon: { purpose: string }) => icon.purpose === purpose);
    expect(byPurpose("any").map((i: { sizes: string }) => i.sizes).sort()).toEqual([
      "192x192",
      "512x512",
    ]);
    expect(byPurpose("maskable").map((i: { sizes: string }) => i.sizes)).toEqual(["512x512"]);
  });

  it("ships every referenced icon at the declared pixel size", () => {
    for (const icon of manifest.icons) {
      expect(icon.type).toBe("image/png");
      const [width, height] = icon.sizes.split("x").map(Number);
      const actual = pngSize(join(publicDir, icon.src));
      expect(actual, icon.src).toEqual({ width, height });
    }
  });

  it("ships a 180px apple-touch-icon", () => {
    expect(pngSize(join(publicDir, "icons", "apple-touch-icon.png"))).toEqual({
      width: 180,
      height: 180,
    });
  });
});

describe("index.html install metadata", () => {
  const html = readFileSync(join(pkgRoot, "index.html"), "utf-8");

  it("links the manifest and the apple-touch-icon", () => {
    expect(html).toContain('rel="manifest" href="/manifest.webmanifest"');
    expect(html).toContain('rel="apple-touch-icon" href="/icons/apple-touch-icon.png"');
  });

  it("declares the mobile web-app metadata", () => {
    expect(html).toContain('name="mobile-web-app-capable" content="yes"');
    expect(html).toContain('name="apple-mobile-web-app-capable" content="yes"');
    expect(html).toContain('name="apple-mobile-web-app-title" content="Valet"');
  });
});
